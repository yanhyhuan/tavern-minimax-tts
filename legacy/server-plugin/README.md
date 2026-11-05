# 旧版服务端插件

> 此目录仅为旧版兼容保留。当前扩展只需通过扩展 URL 安装，不需要安装本服务端插件或开启 `enableServerPlugins`。旧收藏可在此插件仍运行时自动复制到酒馆账号文件；确认迁移完成后再自行处理旧部署。

本目录为 **MINIMAX TTS V1.1** 的 SillyTavern 服务端插件，负责处理 MiniMax TTS 接口请求、副 LLM 安全代理、普通语音缓存自动管理以及服务端持久化语音收藏夹。无需修改任何 SillyTavern 核心文件。

**仅用于 Node.js 版 SillyTavern，TauriTavern 不加载此目录。** 需要 Node.js 18 或更新版本，包含 `index.js`、`network.js` 和 `package.json`，无需额外安装运行依赖。`Group ID` 为可选项。

## 1. 旧数据迁移

已经部署此插件的用户，可在更新前端扩展后打开「语音收藏」，等待旧收藏复制到当前酒馆账号。确认收藏可以正常播放并导出备份后，再处理旧部署。

本目录移至 `legacy/server-plugin/` 仅为整理源码；旧部署的插件 ID、接口路由和数据目录保持不变。

## 2. 数据存储结构

插件运行后会在 SillyTavern 根目录下自动创建并维护 `data/minimax-quote-tts/`：

- `favorites/audio/`：用户收藏的持久化音频文件（不受缓存清理影响）
- `metadata/favorites.json`：收藏索引（采用临时文件原子替换 + 串行写入队列，防止并发损坏）
- `cache/`：普通 TTS 语音缓存（默认保留 7 天、上限 1024 MB，自动淘汰过期或最旧文件）

## 3. 路由接口一览

路由前缀：`/api/plugins/minimax-quote-tts`

- `GET  /status`：只读诊断接口（返回插件版本 `V1.1`、Node 版本、收藏数量、音频占用体积与缺失文件数，不暴露任何密钥）
- `POST /generate-voice`：调用 MiniMax T2A v2 接口生成语音（支持多节点自动容灾切换与情绪枚举校验）
- `POST /proxy`：副 LLM HTTPS 转发接口；检查 IPv4/IPv6 公网地址，连接固定到已校验的 DNS 结果，禁止重定向，设置 45 秒请求超时和 40MB 响应上限
- `GET  /cache/status`：查询普通音频缓存文件数与占用字节数
- `POST /cache/cleanup`：按最大保留天数与容量上限清理普通音频缓存
- `POST /cache` & `GET /cache/:filename`：写入与读取普通 TTS 缓存音频
- `GET  /favorites` & `POST /favorites`：获取收藏列表 / 新增收藏语音
- `GET  /favorites/export` & `POST /favorites/import`：导出 / 导入收藏夹 JSON 完整备份包（含音频 Base64）
- `POST /favorites/batch-delete`：批量删除指定收藏及对应音频
- `GET  /favorites/:id`、`PATCH /favorites/:id`、`DELETE /favorites/:id`：单条收藏详情、修改标题/标签/备注、删除收藏
- `GET  /favorites/:id/audio` & `GET /favorites/:id/download`：在线试听流与附件下载
