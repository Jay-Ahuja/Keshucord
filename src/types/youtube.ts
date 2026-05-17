import type { Privacy } from './stream';

export interface YouTubeUser {
  id: string;
  name: string;
  email: string;
  channel: string;
  avatarUrl?: string;
  avatarColor?: string;
  channelId?: string;
  channelThumbnailUrl?: string;
}

export type BroadcastStatus =
  | 'created'
  | 'ready'
  | 'testStarting'
  | 'testing'
  | 'liveStarting'
  | 'live'
  | 'complete'
  | 'revoked';

export interface YouTubeBroadcast {
  id: string;
  title: string;
  description: string;
  privacy: Privacy;
  category: string;
  status: BroadcastStatus;
  watchUrl: string;
  scheduledStartTime: string;
  boundStreamId?: string;
}

export interface YouTubeLiveStream {
  id: string;
  title: string;
}

export interface StreamIngestionInfo {
  streamId: string;
  streamKey: string;
  rtmpUrl: string;
  backupRtmpUrl?: string;
}

export interface CreateBroadcastInput {
  title: string;
  description?: string;
  privacyStatus: Privacy;
  category?: string;
}

export interface CreateLiveStreamInput {
  title: string;
}
