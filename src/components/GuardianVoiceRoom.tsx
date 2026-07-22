'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from 'livekit-client';

interface GuardianVoiceRoomProps {
  sessionId: string;
  targetTitle: string;
}

interface LiveKitConfig {
  enabled: boolean;
  wsUrl: string;
  mode: 'livekit-room' | 'livekit-room-transport-only' | 'push-to-talk-fallback';
  voiceMode: 'local' | 'google-live';
  voiceProvider: 'local' | 'google-gemini-live';
  voiceModeSummary: string;
  cloudReasoningMode: 'local-only' | 'cloud-reasoning' | 'cloud-realtime';
  cloudReasoningPolicy: string;
  cloudReasoningUsesSanitizedText: boolean;
  cloudReasoningUsesRawAudio: boolean;
  features: {
    interruptionHandling: boolean;
    semanticTurnDetection: boolean;
    wakeWord: boolean;
  };
  agentName: string;
  realtimeConversationReady: boolean;
  guardianVoiceAgentConfigured: boolean;
  pushToTalkTranscriptionConfigured: boolean;
  appUrl: string;
  agentModel: string;
  agentVoice: string;
}

function initialAgentEvent(targetTitle: string): string {
  return targetTitle
    ? `Waiting for guardian events about ${targetTitle}.`
    : 'Waiting for guardian events from this session.';
}

function voiceSubtitle(config: LiveKitConfig | null, targetTitle: string): string {
  if (!config) return `Loading voice transport for ${targetTitle || 'this session'}...`;
  if (config.realtimeConversationReady) {
    return `${config.agentName} is ready for ${targetTitle || 'this focus session'}.`;
  }
  if (!config.enabled) return `Realtime voice is not configured; push-to-talk remains active for ${targetTitle || 'this session'}.`;
  if (config.voiceMode === 'google-live') {
    return `Room transport is ready for ${targetTitle || 'this session'}, but the realtime worker is not fully configured yet.`;
  }
  return `Room transport is ready for ${targetTitle || 'this session'}, but local voice mode keeps realtime conversation disabled.`;
}

function cloudReasoningLine(config: LiveKitConfig | null, targetTitle: string): string {
  if (config?.cloudReasoningPolicy) return config.cloudReasoningPolicy;
  return targetTitle
    ? `Cloud reasoning will use sanitized text from ${targetTitle} when available.`
    : 'Cloud reasoning will use sanitized session text when available.';
}

function modelLine(config: LiveKitConfig | null, targetTitle: string): string {
  if (config?.agentModel) return config.agentModel;
  return targetTitle
    ? `Not configured for ${targetTitle}; push-to-talk still carries session context.`
    : 'Not configured; push-to-talk still carries session context.';
}

function voiceLine(config: LiveKitConfig | null, targetTitle: string): string {
  if (config?.agentVoice) return config.agentVoice;
  return targetTitle
    ? `Session default for ${targetTitle}`
    : 'Session default';
}

function pushToTalkLine(config: LiveKitConfig | null, targetTitle: string): string {
  if (config?.pushToTalkTranscriptionConfigured) {
    return targetTitle
      ? `whisper.cpp ready for ${targetTitle}`
      : 'whisper.cpp ready for this session';
  }
  return targetTitle
    ? `manual transcript fallback; replies still use ${targetTitle} context`
    : 'manual transcript fallback; replies still use session context';
}

export default function GuardianVoiceRoom({ sessionId, targetTitle }: GuardianVoiceRoomProps) {
  const [config, setConfig] = useState<LiveKitConfig | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(false);
  const [remoteParticipants, setRemoteParticipants] = useState<string[]>([]);
  const [activeSpeakers, setActiveSpeakers] = useState<string[]>([]);
  const [lastDataEvent, setLastDataEvent] = useState<string>(() => initialAgentEvent(targetTitle));
  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLastDataEvent(initialAgentEvent(targetTitle));
  }, [sessionId, targetTitle]);

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      try {
        const response = await fetch('/api/voice/livekit/config');
        const data = (await response.json()) as LiveKitConfig;
        if (!cancelled) setConfig(data);
      } catch (fetchError) {
        if (!cancelled) {
          setConfig(null);
          setError(String(fetchError));
        }
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
      void disconnect();
    };
  }, [sessionId]);

  async function disconnect() {
    const room = roomRef.current;
    if (!room) {
      setStatus('idle');
      setMicEnabled(false);
      return;
    }

    room.removeAllListeners();
    room.disconnect();
    roomRef.current = null;
    if (audioContainerRef.current) {
      audioContainerRef.current.innerHTML = '';
    }
    setStatus('idle');
    setMicEnabled(false);
    setRemoteParticipants([]);
    setActiveSpeakers([]);
  }

  function attachRemoteAudio(track: RemoteTrack, participant: RemoteParticipant) {
    if (track.kind !== Track.Kind.Audio || !audioContainerRef.current) {
      return;
    }

    const element = track.attach();
    element.setAttribute('data-participant', participant.identity);
    element.autoplay = true;
    audioContainerRef.current.appendChild(element);
  }

  function detachRemoteAudio(track: RemoteTrack, participant: RemoteParticipant) {
    track.detach().forEach((element) => {
      if (element.parentElement === audioContainerRef.current) {
        audioContainerRef.current?.removeChild(element);
      }
    });

    if (!audioContainerRef.current) return;
    audioContainerRef.current
      .querySelectorAll(`[data-participant="${participant.identity}"]`)
      .forEach((element) => element.remove());
  }

  async function connect() {
    try {
      setStatus('connecting');
      setError(null);

      const tokenResponse = await fetch('/api/voice/livekit/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          targetTitle,
          participantName: 'LifeOS Browser',
        }),
      });

      const tokenPayload = await tokenResponse.json();
      if (!tokenResponse.ok) {
        throw new Error(tokenPayload.error || 'Failed to create LiveKit token');
      }

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      room.on(RoomEvent.ConnectionStateChanged, (nextState) => {
        if (nextState === ConnectionState.Connected) {
          setStatus('connected');
        } else if (nextState === ConnectionState.Disconnected) {
          setStatus('idle');
          setMicEnabled(false);
        }
      });

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        setRemoteParticipants((current) => Array.from(new Set([...current, participant.name || participant.identity])));
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        setRemoteParticipants((current) =>
          current.filter((name) => name !== (participant.name || participant.identity))
        );
      });

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        setActiveSpeakers(speakers.map((speaker) => speaker.name || speaker.identity));
      });

      room.on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          attachRemoteAudio(track, participant);
        }
      );

      room.on(
        RoomEvent.TrackUnsubscribed,
        (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          detachRemoteAudio(track, participant);
        }
      );

      room.on(RoomEvent.DataReceived, (payload, participant) => {
        try {
          const decoded = new TextDecoder().decode(payload);
          const parsed = JSON.parse(decoded) as { type?: string; text?: string };
          setLastDataEvent(parsed.text || parsed.type || decoded);
        } catch {
          setLastDataEvent(`Data event from ${participant?.name || participant?.identity || 'agent'}`);
        }
      });

      await room.connect(tokenPayload.wsUrl, tokenPayload.token, { autoSubscribe: true });
      await room.localParticipant.setMicrophoneEnabled(true);
      roomRef.current = room;
      setMicEnabled(true);
      setRemoteParticipants(
        Array.from(room.remoteParticipants.values()).map((participant) => participant.name || participant.identity)
      );
      setStatus('connected');
    } catch (connectError) {
      setStatus('error');
      setError(String(connectError));
      await disconnect();
    }
  }

  async function toggleMic() {
    const room = roomRef.current;
    if (!room) return;

    const nextState = !micEnabled;
    await room.localParticipant.setMicrophoneEnabled(nextState);
    setMicEnabled(nextState);
  }

  const liveKitEnabled = config?.enabled;
  const realtimeReady = config?.realtimeConversationReady;
  const subtitle = voiceSubtitle(config, targetTitle);

  return (
    <div
      style={{
        background: '#111827',
        border: '1px solid #1f2937',
        borderRadius: '10px',
        padding: '12px',
        marginTop: '10px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div>
          <div style={{ fontSize: '10px', color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
            Realtime Guardian Voice
          </div>
          <div style={{ fontSize: '12px', color: '#dbeafe', marginTop: '2px' }}>
            {subtitle}
          </div>
        </div>
        <div style={{ fontSize: '11px', color: '#9ca3af' }}>
          {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Idle'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <button
          onClick={status === 'connected' ? disconnect : connect}
          disabled={!liveKitEnabled || !realtimeReady || status === 'connecting'}
          style={{
            flex: 1,
            border: 'none',
            borderRadius: '8px',
            padding: '10px 12px',
            fontWeight: 700,
            cursor: liveKitEnabled && realtimeReady ? 'pointer' : 'not-allowed',
            background: status === 'connected' ? '#1d4ed8' : '#2563eb',
            color: '#fff',
            opacity: liveKitEnabled && realtimeReady ? 1 : 0.5,
          }}
        >
          {status === 'connected' ? 'Leave Voice Room' : 'Join Voice Room'}
        </button>
        <button
          onClick={toggleMic}
          disabled={status !== 'connected'}
          style={{
            border: '1px solid #374151',
            borderRadius: '8px',
            padding: '10px 12px',
            fontWeight: 700,
            cursor: status === 'connected' ? 'pointer' : 'not-allowed',
            background: micEnabled ? '#065f46' : '#1f2937',
            color: '#fff',
            opacity: status === 'connected' ? 1 : 0.5,
          }}
        >
          {micEnabled ? 'Mute Mic' : 'Unmute Mic'}
        </button>
      </div>

      <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: 1.5 }}>
        <div>Voice mode: {config?.voiceMode || 'local'}</div>
        <div>Provider: {config?.voiceProvider || 'local'}</div>
        <div>Reasoning mode: {config?.cloudReasoningMode || 'cloud-reasoning'}</div>
        <div>Model: {modelLine(config, targetTitle)}</div>
        <div>Voice: {voiceLine(config, targetTitle)}</div>
        <div>Interruptions: {config?.features.interruptionHandling ? 'enabled' : 'disabled'}</div>
        <div>Semantic turns: {config?.features.semanticTurnDetection ? 'enabled' : 'disabled'}</div>
        <div>Wake word: {config?.features.wakeWord ? 'enabled' : 'later'}</div>
        <div>Push-to-talk STT: {pushToTalkLine(config, targetTitle)}</div>
        <div>{config?.voiceModeSummary || 'Local-first voice mode'}</div>
        <div>{cloudReasoningLine(config, targetTitle)}</div>
      </div>

      <div style={{ marginTop: '10px', fontSize: '11px', color: '#d1d5db', lineHeight: 1.5 }}>
        <div>Remote participants: {remoteParticipants.length > 0 ? remoteParticipants.join(', ') : 'none yet'}</div>
        <div>Active speakers: {activeSpeakers.length > 0 ? activeSpeakers.join(', ') : 'none'}</div>
        <div>Agent event: {lastDataEvent}</div>
      </div>

      {error ? (
        <div style={{ marginTop: '10px', color: '#fca5a5', fontSize: '11px' }}>{error}</div>
      ) : null}

      <div ref={audioContainerRef} style={{ display: 'none' }} />
    </div>
  );
}
