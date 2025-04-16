// 北京联通公免免流服务器 - 增强版
const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const crypto = require('crypto');
const net = require('net');
const url = require('url');
const { Buffer } = require('buffer');

// 创建应用和服务器
const app = express();
const server = http.createServer(app);

// 生成UUID
const SERVER_UUID = process.env.SERVER_UUID || crypto.randomUUID();
console.log(`服务器UUID: ${SERVER_UUID}`);

// WebSocket服务器
const wss = new WebSocket.Server({ 
  server: server,
  path: '/unicom'
});

// V2ray请求解析和处理
class V2rayProcessor {
  // VMess头部解析
  static parseVmessHeader(buffer) {
    try {
      // 这里简化了解析，实际VMess协议更复杂
      // 返回true表示认证通过
      return true;
    } catch (error) {
      console.error('解析VMess头部失败:', error);
      return false;
    }
  }

  // 创建转发响应
  static createResponse(statusCode, headers, body) {
    let response = `HTTP/1.1 ${statusCode}\r\n`;
    for (const [key, value] of Object.entries(headers)) {
      response += `${key}: ${value}\r\n`;
    }
    response += '\r\n';
    if (body) {
      response += body;
    }
    return Buffer.from(response);
  }

  // 添加联通特定请求头
  static addUnicomHeaders(headers) {
    return {
      ...headers,
      'Host': 'wo.10010.com',
      'User-Agent': 'UNICOM/android 8.0102',
      'X-Online-Host': 'wo.10010.com',
      'Connection': 'keep-alive',
      'Accept': '*/*'
    };
  }

  // 处理HTTP请求
  static async handleHttpRequest(requestData) {
    try {
      // 简单解析HTTP请求
      const requestStr = requestData.toString('utf8');
      const requestLines = requestStr.split('\r\n');
      const [method, path, version] = requestLines[0].split(' ');
      
      // 提取请求头
      const headers = {};
      let headerEnd = 1;
      for (let i = 1; i < requestLines.length; i++) {
        if (requestLines[i] === '') {
          headerEnd = i;
          break;
        }
        const [key, value] = requestLines[i].split(': ');
        headers[key] = value;
      }
      
      // 提取请求体
      const body = requestLines.slice(headerEnd + 1).join('\r\n');
      
      // 添加联通特定请求头
      const modifiedHeaders = this.addUnicomHeaders(headers);
      
      // 封装请求选项
      const parsedUrl = url.parse(path);
      const options = {
        hostname: parsedUrl.hostname || 'wo.10010.com',
        port: parsedUrl.port || 80,
        path: parsedUrl.path || '/',
        method: method,
        headers: modifiedHeaders
      };
      
      // 发起请求
      return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk;
          });
          res.on('end', () => {
            resolve(this.createResponse(
              `${res.statusCode} ${res.statusMessage}`,
              res.headers,
              responseData
            ));
          });
        });
        
        req.on('error', (error) => {
          console.error('代理请求错误:', error);
          reject(error);
        });
        
        if (body) {
          req.write(body);
        }
        req.end();
      });
    } catch (error) {
      console.error('处理HTTP请求错误:', error);
      return this.createResponse('500 Internal Server Error', {
        'Content-Type': 'text/plain',
        'Connection': 'close'
      }, 'Internal Server Error');
    }
  }

  // 处理HTTPS请求 (通过隧道)
  static createTunnel(targetHost, targetPort, clientSocket) {
    return new Promise((resolve, reject) => {
      // 创建到目标服务器的连接
      const serverSocket = net.connect(targetPort, targetHost, () => {
        // 连接成功，发送成功响应给客户端
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        
        // 双向数据转发
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
        
        resolve(serverSocket);
      });
      
      // 错误处理
      serverSocket.on('error', (error) => {
        console.error(`隧道连接错误: ${error.message}`);
        reject(error);
      });
    });
  }

  // 主要请求处理函数
  static async processRequest(data) {
    try {
      // 默认返回成功响应
      if (data.length === 0) {
        return Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n联通免流代理响应');
      }

      // 尝试作为HTTP请求处理
      return await this.handleHttpRequest(data);
    } catch (error) {
      console.error('处理请求错误:', error);
      return Buffer.from('HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n服务器内部错误');
    }
  }
}

// WebSocket连接处理
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`新连接: ${ip} - ${new Date().toLocaleString()}`);
  
  // 记录重要的请求头，对免流很关键
  const importantHeaders = [
    'host', 'user-agent', 'x-forwarded-for', 'upgrade', 
    'connection', 'sec-websocket-key', 'sec-websocket-version'
  ];
  
  const headerInfo = {};
  importantHeaders.forEach(h => {
    if (req.headers[h]) {
      headerInfo[h] = req.headers[h];
    }
  });
  console.log(`请求头: ${JSON.stringify(headerInfo)}`);

  // 初始会话状态
  let isAuthenticated = false;
  let targetSocket = null;
  let pendingRequests = [];

  // 保持连接活跃的ping
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch (e) {
        clearInterval(pingInterval);
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  ws.on('message', async (message) => {
    try {
      if (!isAuthenticated) {
        // 处理认证
        isAuthenticated = V2rayProcessor.parseVmessHeader(message);
        if (isAuthenticated) {
          console.log(`认证成功: ${ip}`);
          // 发送认证成功响应
          ws.send(Buffer.from([0x05, 0x00]));
          
          // 处理等待中的请求
          if (pendingRequests.length > 0) {
            console.log(`处理${pendingRequests.length}个等待中的请求`);
            for (const req of pendingRequests) {
              try {
                const response = await V2rayProcessor.processRequest(req);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(response);
                }
              } catch (e) {
                console.error('处理等待请求错误:', e);
              }
            }
            pendingRequests = [];
          }
        } else {
          console.log(`认证失败: ${ip}`);
          ws.close(1008, 'Authentication failed');
        }
      } else {
        // 处理已认证的请求
        console.log(`处理请求: ${ip}, 长度=${message.length}字节`);
        const response = await V2rayProcessor.processRequest(message);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(response);
        }
      }
    } catch (error) {
      console.error(`处理数据错误: ${error.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'Internal server error');
      }
    }
  });

  // ping响应处理
  ws.on('pong', () => {
    // console.log(`收到Pong: ${ip}`);
  });

  // 连接关闭处理
  ws.on('close', (code, reason) => {
    console.log(`连接关闭: ${ip} - 代码: ${code}, 原因: ${reason || '未提供'}`);
    clearInterval(pingInterval);
    if (targetSocket) {
      targetSocket.destroy();
      targetSocket = null;
    }
  });

  // 错误处理
  ws.on('error', (error) => {
    console.error(`WebSocket错误: ${error.message}`);
    clearInterval(pingInterval);
    if (targetSocket) {
      targetSocket.destroy();
      targetSocket = null;
    }
  });
});

// 联通风格首页
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>中国联通</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {background:#f0f0f0; font-family:Arial, sans-serif; text-align:center; margin:0; padding:0;}
          .logo {color:#e60012; font-size:24px; margin-top:50px; font-weight:bold;}
          .content {margin:20px auto; max-width:500px; padding:20px;}
          .status {background:#fff; border-radius:5px; padding:15px; margin-top:20px; box-shadow:0 2px 5px rgba(0,0,0,0.1);}
          .footer {font-size:12px; color:#999; margin-top:50px;}
          .version {font-size:10px; color:#ccc; margin-top:5px;}
        </style>
      </head>
      <body>
        <div class="logo">中国联通</div>
        <div class="content">
          <p>系统正在维护中，请稍后再试...</p>
          <div class="status">
            <p>UUID: ${SERVER_UUID}</p>
            <p>WebSocket路径: /unicom</p>
            <p>服务状态: 运行中</p>
            <p>当前时间: ${new Date().toLocaleString()}</p>
            <p>连接数: ${wss.clients.size}</p>
          </div>
        </div>
        <div class="footer">联通免流服务 &copy; 2025</div>
        <div class="version">V2.0.0</div>
      </body>
    </html>
  `);
});

// 获取配置信息的接口
app.get('/config', (req, res) => {
  res.json({
    uuid: SERVER_UUID,
    path: '/unicom',
    host: req.headers.host,
    created: new Date().toISOString(),
    status: 'active',
    version: '2.0.0',
    connections: wss.clients.size
  });
});

// 服务器状态接口
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    uuid: SERVER_UUID,
    connections: wss.clients.size,
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
    },
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// 客户端配置生成接口
app.get('/client-config', (req, res) => {
  const host = req.headers.host || 'localhost';
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  
  const vmessConfig = {
    v: '2',
    ps: '联通免流',
    add: host,
    port: isHttps ? 443 : 80,
    id: SERVER_UUID,
    aid: 0,
    net: 'ws',
    type: 'none',
    host: 'wo.10010.com',
    path: '/unicom',
    tls: isHttps ? 'tls' : '',
    sni: 'wo.10010.com'
  };
  
  const vmessLink = 'vmess://' + Buffer.from(JSON.stringify(vmessConfig)).toString('base64');
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>联通免流客户端配置</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {background:#f5f5f5; font-family:Arial, sans-serif; padding:20px;}
          .container {max-width:600px; margin:0 auto; background:white; padding:20px; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.1);}
          h1 {color:#e60012; font-size:24px; text-align:center;}
          .config {background:#f8f8f8; padding:15px; border-radius:5px; word-break:break-all; margin:15px 0;}
          .qrcode {text-align:center; margin:20px 0;}
          .copy-btn {display:block; background:#0078d7; color:white; border:none; padding:8px 15px; border-radius:4px; cursor:pointer; margin:10px 0; width:100%;}
          .notice {color:#e60012; font-weight:bold;}
          .version {font-size:12px; color:#999; text-align:center; margin-top:20px;}
        </style>
      </head>
      <body>
        <div class="container">
          <h1>联通免流客户端配置</h1>
          
          <h3>VMess链接</h3>
          <div class="config">${vmessLink}</div>
          <button class="copy-btn" onclick="copyToClipboard('${vmessLink}')">复制VMess链接</button>
          
          <h3>配置详情</h3>
          <ul>
            <li>服务器: ${host}</li>
            <li>端口: ${isHttps ? 443 : 80}</li>
            <li>UUID: ${SERVER_UUID}</li>
            <li>额外ID: 0</li>
            <li>传输协议: WebSocket (ws)</li>
            <li>路径: /unicom</li>
            <li>TLS: ${isHttps ? '开启' : '关闭'}</li>
            <li>传输层安全: ${isHttps ? 'tls' : '无'}</li>
            <li>伪装域名: wo.10010.com</li>
          </ul>
          
          <h3>联通免流特别说明</h3>
          <p>1. 请将APN设置为: <span class="notice">3gnet</span></p>
          <p>2. 确保头部信息包含: <span class="notice">Host: wo.10010.com</span></p>
          <p>3. 确保头部信息包含: <span class="notice">User-Agent: UNICOM/android 8.0102</span></p>
          <p>4. 如无法连接，请刷新此页面唤醒服务</p>
          <p>5. V2rayNG设置中开启"绕过中国大陆"</p>
          
          <h3>常见问题</h3>
          <p>Q: 连接成功但无法上网?</p>
          <p>A: 确认已正确设置APN为3gnet，并开启TLS</p>
          <p>Q: 连接不稳定经常断开?</p>
          <p>A: 服务器可能休眠，请访问此页面唤醒</p>
        </div>
        
        <div class="version">北京联通免流 v2.0.0</div>
        
        <script>
          function copyToClipboard(text) {
            // 创建临时元素
            const input = document.createElement('textarea');
            input.value = text;
            document.body.appendChild(input);
            input.select();
            
            // 尝试复制
            try {
              document.execCommand('copy');
              alert('已复制到剪贴板!');
            } catch (err) {
              alert('复制失败，请手动复制');
            }
            
            // 移除临时元素
            document.body.removeChild(input);
          }
          
          // 保持服务活跃
          setInterval(() => {
            fetch('/status')
              .then(response => response.json())
              .then(data => console.log('服务状态: ', data.status))
              .catch(err => console.error('状态检查失败: ', err));
          }, 240000); // 4分钟检查一次
        </script>
      </body>
    </html>
  `);
});

// 适配多平台的保活机制
const keepAlive = () => {
  setInterval(() => {
    const activeConnections = wss.clients.size;
    console.log(`[${new Date().toLocaleString()}] 保持服务活跃中... 连接数:${activeConnections}`);
    
    // 判断当前运行平台
    const platform = getPlatform();
    
    // 根据不同平台选择不同的保活方法
    try {
      // 获取当前主机
      const host = getServerHost(platform);
      if (host) {
        http.get(`http://${host}/status`, (res) => {
          console.log(`保活请求成功: ${res.statusCode}`);
        }).on('error', (err) => {
          console.error(`保活请求失败: ${err.message}`);
        });
      }
    } catch (error) {
      console.error(`保活失败: ${error.message}`);
    }
  }, 240000); // 每4分钟ping一次
};

// 获取当前运行平台
function getPlatform() {
  if (process.env.GLITCH_EDITOR_VERSION) {
    return 'glitch';
  } else if (process.env.RENDER) {
    return 'render'; 
  } else if (process.env.RAILWAY_STATIC_URL) {
    return 'railway';
  } else if (process.env.REPL_ID) {
    return 'replit';
  } else if (process.env.HEROKU_APP_ID) {
    return 'heroku';
  } else {
    return 'unknown';
  }
}

// 根据平台获取服务器主机名
function getServerHost(platform) {
  switch (platform) {
    case 'glitch':
      return `${process.env.PROJECT_DOMAIN}.glitch.me`;
    case 'render':
      return process.env.RENDER_EXTERNAL_HOSTNAME;
    case 'railway':
      return process.env.RAILWAY_STATIC_URL?.replace(/^https?:\/\//, '');
    case 'replit':
      return process.env.REPL_SLUG ? `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co` : null;
    case 'heroku':
      return process.env.HEROKU_APP_NAME ? `${process.env.HEROKU_APP_NAME}.herokuapp.com` : null;
    default:
      return null;
  }
}

// 监听端口
const port = process.env.PORT || 3000;
const listener = server.listen(port, () => {
  console.log(`北京联通免流服务器运行在端口 ${port}`);
  keepAlive();
});

// 增加错误处理
process.on('uncaughtException', (error) => {
  console.error(`未捕获异常: ${error.message}`);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:');
  console.error(reason);
}); 
