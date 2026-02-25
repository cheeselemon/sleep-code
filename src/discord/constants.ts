/** Discord bot message content limit (2000 chars). Nitro is 4000 but bots don't get Nitro. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** Safe content limit with room for prefixes like "**Claude:** " */
export const DISCORD_SAFE_CONTENT_LIMIT = DISCORD_MESSAGE_LIMIT - 100;
