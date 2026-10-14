export type AdapterMode = "app-server" | "cli" | "dsh";
export type Engine = "codex" | "deepseek" | "openclaw" | "workbuddy" | "workbuddycn";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ModelSelection = { model?: string; effort?: ReasoningEffort };
export type ModelOption = { id:string; label:string; efforts?:string[]; isDefault?:boolean };

export type BridgeConfig = {
  stateDir: string;
  logFile: string;
  pidFile: string;
  adapter: AdapterMode;
  codexBin: string;
  codexModel?: string;
  codexReasoningEffort?: ReasoningEffort;
  dsh?: { executable: string; entry: string; profile: string; patch?: string; workbuddyProxy?: { script: string; port: number; token: string } };
  hybridEnabled?: boolean;
  selectedEngine?: Engine;
  peerEngines?: Record<string,Engine>;
  peerModels?: Record<string,Partial<Record<Engine,ModelSelection>>>;
  routedSessions?: Record<string, Partial<Record<Engine,PeerSession>>>;
  workbuddy?: {wrapper:string;node:string};
  openclaw?: { entry: string; node: string; agentId: string };
  defaultCwd: string;
  approvalPolicy: "untrusted" | "on-request" | "never";
  weixin: {
    baseUrl: string;
    cdnBaseUrl?: string;
    token?: string;
    accountId?: string;
    userId?: string;
    getUpdatesBuf?: string;
    botType: string;
  };
  security: {
    allowFrom: string[];
    adminPeers: string[];
    allowedCwds: string[];
    allowStopFromWeixin: boolean;
  };
  desktopIndex: {
    autoRegister: boolean;
    titlePrefix: string;
  };
  desktopMirror: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  sessions: Record<string, PeerSession>;
  threadBindings: Record<string, ThreadBinding>;
};

export type PeerSession = {
  peerId: string;
  threadId?: string;
  cwd?: string;
  lastContextToken?: string;
  updatedAt: number;
};

export type ThreadBinding = {
  peerId: string;
  updatedAt: number;
};

export type WeixinMessage = {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  create_time_ms?: number;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    image_item?: {
      aeskey?: string;
      media?: {
        full_url?: string;
        aes_key?: string;
        encrypt_query_param?: string;
      };
      mid_size?: number;
      thumb_size?: number;
      thumb_height?: number;
      thumb_width?: number;
      hd_size?: number;
    };
    [key: string]: unknown;
  }>;
};

export type InboundImage = {
  path: string;
  sourceUrl?: string;
  width?: number;
  height?: number;
  size?: number;
};

export type InboundTextMessage = {
  peerId: string;
  text: string;
  images?: InboundImage[];
  contextToken?: string;
  raw: WeixinMessage;
};

export type CodexThread = {
  id: string;
  title?: string | null;
  cwd?: string | null;
  status?: unknown;
  updatedAt?: number | null;
};

export type CodexTurnResult = {
  threadId: string;
  turnId?: string;
  text: string;
  images?: CodexOutputImage[];
};

export type CodexTurnImage = {
  path: string;
  detail?: "auto" | "low" | "high" | "original";
};

export type CodexOutputImage = {
  path: string;
  source?: "imageGeneration" | "imageView" | "markdown" | "local";
};

export type ModelProviderCapabilities = {
  imageGeneration: boolean;
  namespaceTools: boolean;
  webSearch: boolean;
};

export type PendingApproval = {
  shortId: string;
  requestId: string | number;
  method: string;
  threadId?: string;
  summary: string;
  peerId: string;
  createdAt: number;
};
