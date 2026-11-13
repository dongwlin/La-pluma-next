/**
 * 上游账号保存在上游自己的持久数据中，本服务不能生成或轮换密码；两侧必须同步修改，
 * 只改一侧时网关登录上游失败、票据入口返回 503，不会回退到默认值。
 */

export type WebrtcCredentialEnvSource = Readonly<Record<string, string | undefined>>;

export const DEFAULT_WEBRTC_USERNAME = 'admin';
/** 上游 ScrcpyOverWebRTC 的出厂管理员密码；迁移前保持兼容。 */
export const DEFAULT_WEBRTC_PASSWORD = 'admin123';

export type WebrtcCredentialSource = 'default' | 'environment';

export interface WebrtcCredentials {
  username: string;
  password: string;
  /** 是否至少配置了一个覆盖变量；default 表示两侧都在使用上游默认值 */
  source: WebrtcCredentialSource;
  /** 默认弱口令仍在生效，调用方只能提示迁移，不能自动替换 */
  usingDefault: boolean;
}

/**
 * 解析信令凭据。`||` 而非 `??`：空字符串与旧实现一致地视为未配置。
 * 同一份环境输入总是得到同一结果，不包含随机量。
 */
export function resolveWebrtcCredentials(
  env: WebrtcCredentialEnvSource = process.env
): WebrtcCredentials {
  const configuredUsername = env.LA_PLUMA_WEBRTC_USERNAME || '';
  const configuredPassword = env.LA_PLUMA_WEBRTC_PASSWORD || '';
  const usingDefault = configuredUsername === '' && configuredPassword === '';
  return {
    username: configuredUsername || DEFAULT_WEBRTC_USERNAME,
    password: configuredPassword || DEFAULT_WEBRTC_PASSWORD,
    source: usingDefault ? 'default' : 'environment',
    usingDefault
  };
}
