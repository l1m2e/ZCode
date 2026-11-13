# Web 平台适配

`createWebPlatform` 是普通 Web 和手机远控共用的 IPlatformService 实现。平台代理仍只路由原有获准操作；文件保存始终发生在当前浏览器，不把远端文件路径传给桌面下载器。

- `saveFile` 接收原始 ArrayBuffer 或 URL 读取结果，最多 50 MiB，允许空文件。
- URL 内容按流读取并检查实际字节数；异常停止读取。只接受 HTTP、HTTPS、data、blob 来源。
- 下载文件名清理路径和非法字符；触发后移除临时链接并回收 Blob URL。
- success 只表示交付给浏览器下载，不能视为用户已确认或文件已落盘。取消下载无法被页面可靠观察。
- `getSystemFonts` 只调用当前浏览器的 Local Font Access，校验、去重并排序 family 名称，返回 available / unsupported / denied / error；必须从用户操作发起以保留浏览器授权语义。手机远控同样读取手机字体，不经 platform proxy 读取桌面字体，不读取字体二进制。产品及状态所有者见 `docs/ui/settings-appearance.md`。
- 此模块不持有工作区、任务、session 或 stream 状态；现有远控连接、事件和 owner 语义保持不变。
