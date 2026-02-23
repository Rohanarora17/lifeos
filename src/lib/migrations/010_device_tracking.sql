-- Phase 21: Multi-Device Tracking
-- Allows the omni-device tracking loop to record which machine an activity came from
ALTER TABLE activities ADD COLUMN device_name TEXT DEFAULT 'Unknown Device';
