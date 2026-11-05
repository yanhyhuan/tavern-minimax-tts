# 开发说明

## 项目目录

```text
index.js                   酒馆扩展入口与交互
manifest.json              扩展安装信息
style.css                  扩展样式
vrm.js                     随扩展发布的 VRM 渲染构建产物
src/
  runtime.js               远程请求、超时与重试
  host-requests.js         宿主副模型接口适配
  host-storage.js          宿主文件存储适配
  vrm.js                   VRM 渲染源码
tests/                     模块、存储、迁移与发布完整性测试
docs/                      开发说明、来源和验证记录
legacy/server-plugin/      旧版 Node.js 服务端插件
THIRD_PARTY_NOTICES.txt     随构建产物保留的第三方依赖许可
```

根目录的入口、样式和构建产物由酒馆直接加载；`src/` 中的运行模块也随仓库安装。安装扩展无需构建。

## 本地检查与构建

```sh
npm run check
npm test
```

仅修改 VRM 源码或依赖时需要重新构建：

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

`vrm.js` 需要和源码一起提交，运行时不从 CDN 下载脚本。截图、浏览器日志和临时数据保存在工作区外，不提交到仓库。

## 宿主数据

- ST 通过内置 Files API 保存当前账号的收藏、缓存和上传模型，副模型请求使用内置 Chat Completions API。
- TT 使用宿主扩展设置和 `minimax-quote-tts` 扩展存储；同步由宿主管理。
- 旧 IndexedDB 和旧服务端插件仅作收藏迁移来源。逐条复制并记录来源 ID，中断可续迁，原数据保留。
- `legacy/server-plugin/` 保留旧版本兼容实现及测试，新安装只需扩展 URL。
- 仓库名为 `tavern-minimax-tts`；既有设置键名和数据命名空间继续保留，方便读取旧版数据。

来源说明见 [attribution.md](attribution.md)，宿主同步范围和实机验证见 [verification-2026-11-05.md](verification-2026-11-05.md)。
