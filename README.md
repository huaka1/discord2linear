# discord2linear

将 Discord 消息转到 Linear 的 Bot 服务。

## 功能
- 监听 `📌` reaction（忽略 bot 用户）
- 读取消息纯文本，空文本回复 `无可保存内容`
- 调用 Linear GraphQL `issueCreate` 创建任务
- 标题/描述通过 LLM 生成（支持配置 Base URL / API Key / Model）
- 失败时统一回复 `保存失败，请稍后再试`
- 最小去重：同一条 Discord 消息不会重复创建 issue（进程内）

## 目录结构

```text
.
├── bot
│   ├── src/index.ts
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
└── .env.example
```

## 安装与启动（Docker，推荐）

### 1. 准备配置

```bash
cp .env.example .env
```

编辑 `.env`：

```env
DISCORD_TOKEN=your_discord_bot_token
LINEAR_API_KEY=your_linear_api_key
LINEAR_TEAM_KEY=WORK
LINEAR_PROJECT_ID=study

LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your_llm_api_key
LLM_MODEL=gpt-4o-mini
```

说明：

- `LINEAR_PROJECT_ID` 支持填 UUID，或填项目名称（bot 会自动解析为 project id）
- `LLM_BASE_URL` 使用 OpenAI 兼容接口时，程序会自动拼接 `/chat/completions`

### 2. 构建并运行

```bash
docker compose up -d --build bot
```

### 3. 查看日志

```bash
docker compose logs -f bot
```

看到 `Logged in as ...` 即启动成功。

## 本地开发运行（可选）

```bash
cd bot
npm install
npm run build
npm start
```

开发热重载：

```bash
cd bot
npm run dev
```

## 使用方式

1. 在 Discord 某条消息上加 `📌`
2. Bot 会创建 Linear issue
3. 成功时回复 `已保存到 Linear`

## 更新部署

拉取新代码后重建容器：

```bash
docker compose up -d --build bot
```

## 安全建议

如果 token/key 曾公开泄露，请立即在对应平台轮换：

- Discord Bot Token
- Linear API Key
- LLM API Key
