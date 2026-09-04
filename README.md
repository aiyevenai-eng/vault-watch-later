# Vault Watch Later

YouTube 上保存视频到本机 **Trading Journal**（`http://localhost:3000`）的 Chrome 插件。

- **Watch Later**：直接写入本机 Trading Journal 的「待看视频」页
- **写笔记**：打开 Trading Journal 的视频学习页（就是图二那个网站）
- **收藏频道**：保存 YouTuber 到 Trading Journal（若网站已提供该接口）

## 在 Mac 上安装

1. 打开仓库：https://github.com/aiyevenai-eng/vault-watch-later
2. 点 **Code → Download ZIP**，解压
3. Chrome 打开 `chrome://extensions`
4. 打开右上角 **开发者模式**
5. 如果已经装着旧版 Vault Watch Later，先点 **移除**
6. 点 **加载已解压的扩展程序**，选中解压后的文件夹（能看到 `manifest.json` 的那一层）
7. 先启动 Trading Journal（`http://localhost:3000`）
8. 打开任意 YouTube 视频，刷新页面，点操作栏里的 **Watch Later** 或 **写笔记**

「写笔记」会打开：`http://localhost:3000/learning/import?...`，然后进入 `/learning/[id]` 学习页。

## 本机地址

| 服务 | 默认地址 |
| --- | --- |
| Trading Journal | `http://localhost:3000` |
| Vault API（可选） | `http://127.0.0.1:4321` |

点扩展图标可以检测 Trading Journal 是否在跑，并直接打开视频学习 / Watch Later。
