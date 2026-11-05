# 单次安装与宿主同步验证（2026-11-05）

## 实现

- ST 使用内置 Files API 保存当前账号的收藏、缓存和模型，副模型和流式通话使用内置 Chat Completions API。
- MiniMax 使用允许跨域的官方接口，完整传递情绪、语速、音量、音调、语言和 Group ID；保留瞬时失败重试。
- TT 继续使用原生扩展存储；上传模型从浏览器 IndexedDB / 临时 Blob URL 改为可同步的文件引用。
- Key 和其他设置仍保存在宿主的扩展设置中。未修改宿主同步目标、周期或用户选择的范围。
- 旧浏览器和旧服务端收藏复制迁移，逐条提交并按来源 ID 去重；中断可重试，保留原数据。迁移保留旧服务端支持的长文本和备注。

## TT 同步范围核对

核对当前 TT-Sync 的 `crates/ttsync-core/src/dataset/catalog.rs` 和 `profile.rs`：

| 数据集 | 内容 | 默认范围 | 完整范围 |
| --- | --- | --- | --- |
| `settings.core` | 扩展设置、扩展内填写的 MiniMax / 副模型 Key | 包含 | 包含 |
| `extensions.store` | 扩展命名空间内的收藏、音频缓存和上传模型 | 包含 | 包含 |
| `user.files` | 酒馆账号文件，也覆盖兼容文件存储 | 包含 | 包含 |
| `secrets.api_keys` | TT 宿主管理的密钥 | 不包含 | 包含 |

同时核对 TauriTavern 的 `file_settings_repository/fields.rs`：本扩展的设置留在核心设置分区。实际同步仍需用户在 TT 中配置目标并启用；建议完整同步。

## 自动检查

`npm run check`、`npm test` 和 `git diff --check` 通过。共 17 项测试，覆盖文件跨浏览器共享、TT 同步数据在模拟新设备上的读取、模型字节保存、并发缓存、旧收藏中断续迁、完整语音参数、流式取消和错误响应。

## 真实 ST 页面验证

- SillyTavern 1.19.0、Node.js 24.16.0，使用独立临时配置和数据目录；`enableServerPlugins: false`。
- 通过原生扩展安装接口安装仓库，再将当前未发布的工作区文件放入该隔离安装目录。
- 两个独立 Playwright 浏览器会话读取相同收藏和测试 Key 配置。
- 收藏导入、试听和存储读写诊断通过。诊断使用临时文件，完成后删除。
- 向一个会话的旧 IndexedDB 写入测试收藏，重新加载后成功迁移；另一个会话刷新后也能读取。
- MiniMax 三个官方域名的 OPTIONS 预检均返回允许 POST 和 Authorization 的跨域响应；未使用真实密钥调用合成。

## 目录整理

- 远程请求和宿主适配模块统一放入 `src/`，旧服务端插件放入 `legacy/server-plugin/`，同步更新入口、测试及检查脚本中的引用。
- README 仅保留安装及使用说明，开发信息与来源说明放入 `docs/`。
- 整理后重新运行语法检查与 17 项测试，全部通过。

## 未完成的实机联调

- 未进行真实 TT 双设备 LAN Sync / TT-Sync 传输；已完成范围核对和同步载荷模拟测试。
- 未使用付费 API、真实 VRM 模型和麦克风完成语音 / 视频通话联调。
