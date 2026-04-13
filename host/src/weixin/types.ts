export interface WeixinConfig {
  baseUrl: string;
  cdnBaseUrl: string;
}

export enum MessageItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

export enum MessageType {
  USER = 1,
  BOT = 2,
}

export enum MessageState {
  NEW = 0,
  GENERATING = 1,
  FINISH = 2,
}

export enum TypingStatus {
  TYPING = 1,
  CANCEL = 2,
}

export enum UploadMediaType {
  IMAGE = 1,
  VIDEO = 2,
  FILE = 3,
  VOICE = 4,
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface TextItem {
  text: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  mid_size?: number;
  thumb_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

export interface MessageItem {
  type: MessageItemType;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  // TODO: FILE and VIDEO if needed later
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id: string;
  to_user_id: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResponse {
  ret: number;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface BotTokenInfo {
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired' | undefined;
  bot_token?: string | undefined;
  ilink_bot_id?: string | undefined;
  baseurl?: string | undefined;
  ilink_user_id?: string | undefined;
  ret?: number | undefined;
}

/**
 * getuploadurl 接口的请求参数
 * 用于向微信服务器请求文件上传地址
 */
export interface GetUploadUrlRequest {
  filekey: string;
  media_type: UploadMediaType;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

/**
 * getuploadurl 接口的响应
 */
export interface GetUploadUrlResponse {
  ret?: number;
  upload_param: string;
  upload_full_url?: string;
}

/**
 * 媒体上传结果
 * 包含上传后的 CDN 引用信息，可直接用于构建图片消息
 */
export interface UploadMediaResult {
  media: CDNMedia;
  aesKey: Buffer;
  encryptedFileSize: number;
}

// Extracted / unified internal message for our bot logic
export interface UnifiedMessage {
  chatId: string; // usually the from_user_id
  ilink_user_id?: string;
  messageId: string;
  text?: string;
  imageUrls?: string[]; // paths to downloaded local images
  contextToken: string;
}
