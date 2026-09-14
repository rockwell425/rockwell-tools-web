RockwellTools Web 0.1.3 的抠图模型必须位于：

  models/u2netp.onnx

浏览器只从本站同域读取该文件，不会访问 GitHub，因此不会触发 GitHub CORS。
部署后在服务器网站根目录运行：

  sudo bash install-u2netp.sh /var/www/rockwell-tools-web

随后验证：

  bash verify-deployment.sh https://tools.rockwell1453.tech

期望 SHA-256：
309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8
