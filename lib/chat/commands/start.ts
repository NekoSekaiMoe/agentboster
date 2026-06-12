export function executeStartCommand(): { text: string } {
  return {
    text: `欢迎使用 AgentBoster！

可用命令：
/help - 显示帮助信息
/new - 创建新对话
/status - 显示当前状态
/model <provider/model> - 切换模型
/provider - 管理提供商配置
/config - 管理配置
/session - 切换会话
/sessions - 列出所有会话
/compact - 压缩对话上下文
/stop - 停止当前运行
/cancel - 取消当前请求
/retry - 重试上一个失败的请求
/version - 显示版本信息
/id - 显示当前会话 ID

开始与 AI 对话吧！`,
  };
}
