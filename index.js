const express = require("express");
const { MongoClient } = require("mongodb");
const { Client, GatewayIntentBits } = require("discord.js");
const cron = require("node-cron");

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const JOIN_CHANNEL_ID = "1563611863734821004";
const LEAVE_CHANNEL_ID = "1565662690951561306";

const app = express();
app.use(express.json());
app.use(express.text({ type: "*/*" }));

let db;
let eventsCollection;

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

function getTodayKey() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(now);
}

function getTimeKey() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  return formatter.format(now);
}

function extractMessageText(message) {
  if (message.content && message.content.trim().length > 0) {
    return message.content.trim();
  }
  if (message.embeds && message.embeds.length > 0) {
    const parts = [];
    for (const embed of message.embeds) {
      if (embed.title) parts.push(embed.title);
      if (embed.description) parts.push(embed.description);
      if (embed.fields && embed.fields.length > 0) {
        for (const f of embed.fields) {
          parts.push(`${f.name}: ${f.value}`);
        }
      }
    }
    if (parts.length > 0) return parts.join(" | ").trim();
  }
  return "";
}

async function saveActivityEvent({ type, rawText, sourceChannelId }) {
  if (!eventsCollection) return;

  const timeStr = getTimeKey();
  const cleanText = rawText.replace(/\s+/g, " ").trim();
  const summary =
    type === "join"
      ? `[${timeStr}] Join: ${cleanText || "Speler ingelogd"}`
      : `[${timeStr}] Leave: ${cleanText || "Speler uitgelogd"}`;

  await eventsCollection.insertOne({
    date: getTodayKey(),
    time: timeStr,
    type,
    rawText: cleanText,
    sourceChannelId,
    summary,
    receivedAt: new Date()
  });
}

async function initMongo() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI ontbreekt in environment variables.");
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db("minecraft_reports");
  eventsCollection = db.collection("activity_events");
  console.log("Verbonden met MongoDB Atlas");
}

async function sendDailyReport(targetDate = getTodayKey()) {
  if (!eventsCollection || !DISCORD_TOKEN || !CHANNEL_ID) return;

  const docs = await eventsCollection.find({ date: targetDate }).toArray();
  const channel = await discordClient.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  if (docs.length === 0) {
    await channel.send(`📊 **Dagrapport (${targetDate})**: Geen serveractiviteit geregistreerd.`);
    return;
  }

  const lines = docs.slice(-25).map((d) => `• ${d.summary}`);
  const message = [
    `📊 **Dagrapport (${targetDate})**`,
    `Totaal geregistreerde events: **${docs.length}**`,
    ...lines
  ].join("\n");

  await channel.send(message.slice(0, 1950));
}

discordClient.on("messageCreate", async (message) => {
  try {
    if (message.author?.id === discordClient.user?.id) return;

    if (message.channelId === JOIN_CHANNEL_ID) {
      const text = extractMessageText(message);
      await saveActivityEvent({
        type: "join",
        rawText: text,
        sourceChannelId: message.channelId
      });
      console.log(`Join opgeslagen vanuit kanaal ${message.channelId}`);
    } else if (message.channelId === LEAVE_CHANNEL_ID) {
      const text = extractMessageText(message);
      await saveActivityEvent({
        type: "leave",
        rawText: text,
        sourceChannelId: message.channelId
      });
      console.log(`Leave opgeslagen vanuit kanaal ${message.channelId}`);
    }
  } catch (err) {
    console.error("Fout bij verwerken Discord-bericht:", err);
  }
});

app.get("/", (req, res) => {
  res.status(200).send("OK - Minecraft activity reporter actief");
});

app.post("/webhook/aternos", async (req, res) => {
  try {
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const summary =
      typeof req.body === "object" && req.body !== null && req.body.message
        ? String(req.body.message)
        : rawBody.slice(0, 200);

    if (eventsCollection) {
      await eventsCollection.insertOne({
        date: getTodayKey(),
        summary,
        receivedAt: new Date()
      });
    }

    res.status(200).json({ status: "received" });
  } catch (err) {
    console.error("Fout bij verwerken webhook:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

cron.schedule(
  "59 23 * * *",
  async () => {
    console.log("Dagrapport wordt verstuurd...");
    await sendDailyReport(getTodayKey());
  },
  {
    timezone: "Europe/Amsterdam"
  }
);

async function start() {
  await initMongo();

  if (DISCORD_TOKEN) {
    await discordClient.login(DISCORD_TOKEN);
    console.log("Discord bot ingelogd");
  }

  app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Opstartfout:", err);
  process.exit(1);
});
