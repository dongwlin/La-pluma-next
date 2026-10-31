/**
 * 信令服务凭据入口
 *
 * 信令网关通过本机回环地址登录上游 ScrcpyOverWebRTC；上游把账号保存在自己的
 * 持久数据中，启动参数不提供账号开关，因此本服务不能为它生成或轮换密码。
 * 这里只解析“网关使用哪组账号”，默认值与上游出厂账号保持一致：
 *
 * - 未配置 `LA_PLUMA_WEBRTC_USERNAME` / `LA_PLUMA_WEBRTC_PASSWORD` 时沿用上游默认值；
 * - 配置后原样使用（不裁剪空白，密码中的空格是有效字符）；
 * - 两个变量各自解析，未配置的一侧继续使用默认值；
 * - 任何情况下都不生成随机值，避免网关与上游账号不同步。
 *
 * 修改默认弱口令的顺序固定：先在上游修改账号，再同步设置两个变量并重启本服务。
 * 只改一侧时网关登录上游会失败，票据入口返回 503，不会回退到默认值。
 *
 * 本模块导入时无副作用：所有解析通过显式入参完成，缺省读取当前进程环境。
 */

/** 可注入的环境变量来源；`process.env` 天然满足该结构。 */
export type WebrtcCredentialEnvSource = Readonly<Record<string, string | undefined>>;

/** 上游 ScrcpyOverWebRTC 的出默认管理员账号。 */
export const DEFAULT_WEBRTC_USERNAME = 'admin';
/** 上游 ScrcpyOverWebRTC 的出厂管理员密码；迁移前保持兼容。 */
export const DEFAULT_WEBRTC_PASSWORD = 'admin123';

export type WebrtcCredentialSource = 'default' | 'environment';

export interface WebrtcCredentials {
  /** 网关登录上游使用的账号 */
  username: string;
  /** 网关登录上游使用的密码 */
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
