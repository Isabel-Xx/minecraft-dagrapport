import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import mongoose from "mongoose";
import cron from "node-cron";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const {
  MONGODB_URI,
  DISCORD_TOKEN,
  JOIN_CHANNEL_ID = "1563611863734821004",
  LEAVE_CHANNEL_ID = "1565662690951561306",
  REPORT_CHANNEL_ID,
} = process.env;

// MongoDB schema voor speler-events
const activitySchema = new mongoose.Schema(
  {
    player: { type: String, required: true },
    type: { type: String, enum: ["join", "leave"], required: true },
    source: { type: String, default: "discord" },
    rawText: { type: String, default: "" },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const Activity = mongoose.models.Activity || mongoose.model("Activity", activitySchema);

// Haal tekst uit zowel gewone berichten als embeds
function extractMessageText(message) {
  const parts = [];
  if (message.content) parts.push(message.content);

  if (Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      if (embed.title) parts.push(embed.title);
      if (embed.description) parts.push(embed.description);
      if (Array.isArray(embed.fields)) {
        for (const field of embed.fields) {
          if (field.name) parts.push(field.name);
          if (field.value) parts.push(field.value);
        }
      }
      if (embed.footer?.text) parts.push(embed.footer.text);
    }
  }

  return parts.join(" ").trim();
}

// Bepaalt of een tekst een join of leave is en haalt de spelersnaam op
function parseActivityFromText(text) {
  if (!text) return null;

  const joinMatch =
    text.match(/([A-Za-z0-9_]{1,16})\s+joined\s+(?:the\s+)?server/i) ||
    text.match(/([A-Za-z0-9_]{1,16})\s+(?:is\s+binnengekomen|heeft\s+de\s+server\s+betreden)/i);

  if (joinMatch) {
    return { type: "join", player: joinMatch[1] };
  }

  const leaveMatch =
    text.match(/([A-Za-z0-9_]{1,16})\s+left\s+(?:the\s+)?server/i) ||
    text.match(/([A-Za-z0-9_]{1,16})\s+(?:heeft\s+de\s+server\s+verlaten|is\s+weggegaan)/i);

  if (leaveMatch) {
    return { type: "leave", player: leaveMatch[1] };
  }

  return null;
}

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

discordClient.once("ready", () => {
  console.log("Discord bot ingelogd");
});

discordClient.on("messageCreate", async (message) => {
  try {
    if (message.author?.id === discordClient.user?.id) return;

    const isJoinChannel = message.channelId === JOIN_CHANNEL_ID;
    const isLeaveChannel = message.channelId === LEAVE_CHANNEL_ID;

    if (!isJoinChannel && !isLeaveChannel) return;

    const text = extractMessageText(message);
    console.log(
      `Bericht gezien in ${message.channelId} (webhook=${Boolean(message.webhookId)}): "${text}"`
    );

    const parsed = parseActivityFromText(text);
    const fallbackType = isJoinChannel ? "join" : "leave";
    const type = parsed?.type || fallbackType;

    const playerMatch = text.match(/([A-Za-z0-9_]{1,16})/);
    const player = parsed?.player || (playerMatch ? playerMatch[1] : "Onbekend");

    await Activity.create({
      player,
      type,
      source: "discord",
      rawText: text,
      occurredAt: new Date(),
    });

    console.log(
      `${type === "join" ? "Join" : "Leave"} opgeslagen vanuit kanaal ${message.channelId} (${player})`
    );
  } catch (err) {
    console.error("Fout bij verwerken Discord-bericht:", err);
  }
});

// Optionele webhook-route
app.post("/webhook/aternos", async (req, res) => {
  try {
    const payloadText =
      typeof req.body === "string"
        ? req.body
        : req.body?.message || req.body?.text || JSON.stringify(req.body || {});

    const parsed = parseActivityFromText(payloadText);
    const type =
      req.body?.type === "join" || req.body?.type === "leave"
        ? req.body.type
        : parsed?.type || "join";

    const player =
      req.body?.player ||
      parsed?.player ||
      payloadText.match(/([A-Za-z0-9_]{1,16})/)?.[1] ||
      "Onbekend";

    await Activity.create({
      player,
      type,
      source: "webhook",
      rawText: payloadText,
      occurredAt: new Date(),
    });

    console.log(`Webhook verwerkt: ${type} - ${player}`);
    res.status(200).json({ status: "received", type, player });
  } catch (err) {
    console.error("Fout bij verwerken webhook:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/", (_req, res) => {
  res.status(200).send("Minecraft dagrapport service draait.");
});

// Dagrapport versturen om 23:59 (Europe/Amsterdam)
async function sendDailyReport() {
  try {
    if (!REPORT_CHANNEL_ID) {
      console.log("REPORT_CHANNEL_ID is niet ingesteld; dagrapport overgeslagen.");
      return;
    }

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const entries = await Activity.find({ occurredAt: { $gte: startOfDay } }).sort({
      occurredAt: 1,
    });

    const joins = entries.filter((e) => e.type === "join");
    const leaves = entries.filter((e) => e.type === "leave");

    const lines = [
      `**Dagrapport (${now.toISOString().slice(0, 10)})**`,
      `• Joins: **${joins.length}**`,
      `• Leaves: **${leaves.length}**`,
    ];

    if (entries.length > 0) {
      lines.push("", "**Activiteit:**");
      for (const item of entries.slice(-25)) {
        const tijd = new Date(item.occurredAt).toLocaleTimeString("nl-NL", {
          timeZone: "Europe/Amsterdam",
          hour: "2-digit",
          minute: "2-digit",
        });
        lines.push(`- \`${tijd}\` **${item.player}** (${item.type})`);
      }
    } else {
      lines.push("", "Geen speler-activiteit geregistreerd vandaag.");
    }

    const channel = await discordClient.channels.fetch(REPORT_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send(lines.join("\n"));
      console.log("Dagrapport verstuurd naar kanaal", REPORT_CHANNEL_ID);
    } else {
      console.error("Rapportkanaal niet gevonden of niet tekstueel:", REPORT_CHANNEL_ID);
    }
  } catch (err) {
    console.error("Fout bij versturen dagrapport:", err);
  }
}

cron.schedule("59 23 * * *", sendDailyReport, {
  timezone: "Europe/Amsterdam",
});

async function start() {
  try {
    if (!MONGODB_URI) {
      throw new Error("MONGODB_URI ontbreekt in environment variabelen.");
    }
    if (!DISCORD_TOKEN) {
      throw new Error("DISCORD_TOKEN ontbreekt in environment variabelen.");
    }

    await mongoose.connect(MONGODB_URI);
    console.log("Verbonden met MongoDB Atlas");

    await discordClient.login(DISCORD_TOKEN);

    app.listen(PORT, () => {
      console.log(`Server draait op poort ${PORT}`);
    });
  } catch (err) {
    console.error("Fout bij opstarten:", err);
    process.exit(1);
  }
}

start();
