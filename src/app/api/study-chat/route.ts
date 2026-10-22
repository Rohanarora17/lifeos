import { NextResponse } from 'next/server';
import { acknowledgeStudyChatPrompt, getStudyChatState, processStudyChatMessage, StudyChatError } from '@/lib/study-chat';

export const dynamic = 'force-dynamic';
const headers={'Cache-Control':'no-store'};
export async function GET() {
  try {return NextResponse.json(getStudyChatState(),{headers});}
  catch {return NextResponse.json({error:'Study chat is temporarily unavailable. Try again.'},{status:503,headers});}
}
export async function POST(request:Request) {
  try {
    let body:unknown;
    try {body=await request.json();} catch {throw new StudyChatError('A valid JSON object is required.');}
    if(!body || typeof body!=='object' || Array.isArray(body))throw new StudyChatError('A valid JSON object is required.');
    const input=body as Record<string,unknown>;
    if(input.action==='ack_prompt') {
      acknowledgeStudyChatPrompt(input.promptId,input.deviceId);
      return NextResponse.json(getStudyChatState(),{headers});
    }
    if(input.action!=='message')throw new StudyChatError('Unsupported study chat action.');
    return NextResponse.json(await processStudyChatMessage({message:input.message,requestId:input.requestId,revision:input.revision,date:input.date}),{headers});
  } catch(error) {
    if(error instanceof StudyChatError)return NextResponse.json({error:error.message,...(error.status===409?{state:getStudyChatState()}:{})},{status:error.status,headers});
    console.error('[StudyChat] Request failed:',error);
    return NextResponse.json({error:'Could not save your study update. Retry using the same request ID.'},{status:503,headers});
  }
}
