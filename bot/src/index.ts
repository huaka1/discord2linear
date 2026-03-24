import { Client, GatewayIntentBits, Partials } from "discord.js";

const { DISCORD_TOKEN, LINEAR_API_KEY, LINEAR_TEAM_KEY, LINEAR_PROJECT_ID } =
  process.env;
const LLM_BASE_URL =
  process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1";
const LLM_API_KEY = process.env.LLM_API_KEY?.trim() || "";
const LLM_MODEL = process.env.LLM_MODEL?.trim() || "gpt-4o-mini";

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is required");
}
if (!LINEAR_API_KEY) {
  throw new Error("LINEAR_API_KEY is required");
}
if (!LINEAR_TEAM_KEY) {
  throw new Error("LINEAR_TEAM_KEY is required");
}
if (!LINEAR_PROJECT_ID) {
  throw new Error("LINEAR_PROJECT_ID is required");
}

const LINEAR_API_URL = "https://api.linear.app/graphql";
const PIN_EMOJI = "📌";
const MAX_TITLE_LENGTH = 200;
const processedMessageIds = new Set<string>();
const FALLBACK_TITLE = "未命名任务";

const linearRequest = async <T>(query: string, variables?: Record<string, unknown>) => {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear request failed: ${response.status}`);
  }

  const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data) {
    throw new Error("Linear response missing data");
  }

  return payload.data;
};

let cachedTeamId: string | null = null;
let cachedProjectId: string | null = null;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getTeamId = async () => {
  if (cachedTeamId) {
    return cachedTeamId;
  }

  const data = await linearRequest<{
    teams: { nodes: { id: string; key: string }[] };
  }>(
    "query TeamByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }",
    { key: LINEAR_TEAM_KEY }
  );

  const team = data.teams.nodes[0];
  if (!team) {
    throw new Error(`Linear team not found for key ${LINEAR_TEAM_KEY}`);
  }

  cachedTeamId = team.id;
  return team.id;
};

const getProjectId = async () => {
  if (cachedProjectId) {
    return cachedProjectId;
  }

  if (UUID_PATTERN.test(LINEAR_PROJECT_ID)) {
    cachedProjectId = LINEAR_PROJECT_ID;
    return cachedProjectId;
  }

  const data = await linearRequest<{
    projects: { nodes: { id: string; name: string }[] };
  }>("query Projects { projects { nodes { id name } } }");

  const matched = data.projects.nodes.find(
    (project) => project.name.trim().toLowerCase() === LINEAR_PROJECT_ID.trim().toLowerCase()
  );

  if (!matched) {
    throw new Error(
      `Linear project not found by name. LINEAR_PROJECT_ID=${LINEAR_PROJECT_ID}`
    );
  }

  cachedProjectId = matched.id;
  return matched.id;
};

const truncateTitle = (content: string) => {
  if (content.length <= MAX_TITLE_LENGTH) {
    return content;
  }
  return `${content.slice(0, MAX_TITLE_LENGTH - 3)}...`;
};

const llmRequest = async (content: string, messageUrl: string) => {
  if (!LLM_API_KEY) {
    return {
      title: truncateTitle(content) || FALLBACK_TITLE,
      description: `Source: discord\nMessage URL: ${messageUrl}\n\n${content}`,
    };
  }

  const llmApiUrl = `${LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(llmApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你将 Discord 消息转换为 Linear issue。仅输出 JSON，格式为 {\"title\":\"...\",\"description\":\"...\"}。title 必须是中文总结标题（不超过30字）。description 用中文分点总结关键内容，保留链接。",
        },
        {
          role: "user",
          content: `Message URL: ${messageUrl}\nRaw message:\n${content}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = payload.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("LLM response missing content");
  }

  let parsed: { title?: string; description?: string };
  try {
    parsed = JSON.parse(raw) as { title?: string; description?: string };
  } catch {
    throw new Error("LLM response is not valid JSON");
  }

  const title = truncateTitle((parsed.title || "").trim()) || FALLBACK_TITLE;
  const generatedDescription = (parsed.description || "").trim();
  const description = generatedDescription
    ? `Source: discord\nMessage URL: ${messageUrl}\n\n${generatedDescription}`
    : `Source: discord\nMessage URL: ${messageUrl}\n\n${content}`;

  return { title, description };
};

const createIssue = async (title: string, description: string) => {
  const teamId = await getTeamId();
  const projectId = await getProjectId();

  const data = await linearRequest<{
    issueCreate: { success: boolean };
  }>(
    "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success } }",
    {
      input: {
        teamId,
        projectId,
        title,
        description,
      },
    }
  );

  if (!data.issueCreate.success) {
    throw new Error("Linear issueCreate failed");
  }
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.on("clientReady", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) {
    return;
  }

  const emojiName = reaction.emoji.name;
  if (emojiName !== PIN_EMOJI) {
    return;
  }

  try {
    if (reaction.message.partial) {
      await reaction.message.fetch();
    }

    const message = reaction.message;
    if (processedMessageIds.has(message.id)) {
      return;
    }

    const rawContent = message.content?.trim() || "";

    if (!rawContent) {
      await message.reply("无可保存内容");
      return;
    }

    processedMessageIds.add(message.id);

    try {
      const summary = await llmRequest(rawContent, message.url);
      const title = summary.title;
      const description = summary.description;
      await createIssue(title, description);
      await message.reply("已保存到 Linear");
    } catch (createError) {
      processedMessageIds.delete(message.id);
      throw createError;
    }
  } catch (error) {
    console.error("Failed to save task", error);
    try {
      await reaction.message.reply("保存失败，请稍后再试");
    } catch (replyError) {
      console.error("Failed to reply", replyError);
    }
  }
});

client.login(DISCORD_TOKEN);
