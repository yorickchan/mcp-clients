# 用 typescript、express 写的简单的 mcp client

## 准备 mcp server

首先你需要有一个本地的 mcp server。本例中使用<https://github.com/liaokongVFX/MCP-Chinese-Getting-Started-Guide>中的 mcp server

## 启动 mcp client

```bash
npm install
npm run build
node build/index.js D:\project\PycharmProjects\mcp_getting_started\web_search.py
```

## 测试

使用 api 测试工具调用接口。
接口 1：
http://localhost:3000/chat
get 请求
返回：

```json
{
  "status": "ok",
  "tools": ["web_search"]
}
```

接口 2:
http://localhost:3000/chat
post 请求
请求参数示例：

```json
{
  "query": "今天广州的天气"
}
```

返回示例：

```json
{
  "response": "[Calling tool web_search with args {\"query\":\"今天广州天气\"}]\n今天（2025年6月18日）广州的天气情况如下：\n\n- **当前天气**：阴，气温27.3°C，南风1级，湿度94%，空气质量良好（指数18）。\n- **夜间预报**：雷阵雨，最低气温25°C，无持续风向<3级。\n\n**未来7天天气预报**：\n- **6月19日**：白天雷阵雨（33°C，南风3-4级），夜间多云（26°C）。\n- **6月20-24日**：以多云为主，白天最高气温34°C，夜间最低26°C，风力较小。\n\n近期天气较闷热，建议注意防暑降温，夜间有雨时出行记得携带雨具。"
}
```
