# RockwellTools Web

在线地址：**https://tools.rockwell1453.tech/**

免费、无广告、无水印的浏览器端工具箱。图片、音视频、录音、文档与 PDF 均在本地处理，不上传文件、不登录、不加水印。

## 功能

- **智能抠图**：基于 U²-NetP 的本地推理，支持批量抠图与透明背景导出。
- **图片工具**：PNG / JPEG / WebP 格式转换、压缩、缩放与批量导出。
- **录音工具**：麦克风录音、标签页/系统分享音频、混音录制。
- **文档转换**：图片、TXT、Markdown 等转换为 PDF 或常用文档格式。
- **PWA**：可安装到桌面/主屏，离线打开已缓存页面。

## 本地运行

这是一个静态站点，直接用任意静态服务器打开根目录即可：

```bash
python -m http.server 8080
```

然后访问 `http://127.0.0.1:8080/`。

## 抠图模型

智能抠图需要 `models/u2netp.onnx`。仓库默认不包含模型文件，部署时把模型放到该路径，或在服务器网站根目录执行：

```bash
sudo bash install-u2netp.sh /var/www/rockwell-tools-web
```

具体说明见 `models/README.txt`。

## 部署

仓库内的 `nginx-0.1.3-snippet.conf` 是参考 nginx 片段，`verify-deployment.sh` 用于部署后自检。线上站点使用 HTTPS，Service Worker 只缓存同源资源。

## 隐私

- 文件在浏览器内处理，不上传到服务器。
- 不收集账号、文件内容或使用统计。
- 录音/麦克风权限只在用户主动点击后申请。

## 许可证

当前仓库未声明开源许可证；如需复用代码，请先联系仓库所有者。
