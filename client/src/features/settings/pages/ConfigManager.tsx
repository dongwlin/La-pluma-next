/**
 * 设置页
 *
 * 页面只组合设置工作区；section、连接草稿、设备/目录读取、更新与自动更新
 * 分别由工作区和面板持有，页面不访问 API、Query、命令所有者或 localStorage。
 */

import SettingsWorkspace from '../components/SettingsWorkspace'

export default function ConfigManager() {
  return (
    <div className="app-page app-stack-section ios-workspace-page ios-borderless-cards" data-page="config">
      <SettingsWorkspace />
    </div>
  )
}
