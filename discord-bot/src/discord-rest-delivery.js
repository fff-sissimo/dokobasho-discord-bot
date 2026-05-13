const logger = require('./logger');

const DEFAULT_API_BASE_URL = 'https://discord.com/api/v10';

const normalizeString = (value) => String(value ?? '').trim();

class DiscordRestError extends Error {
    constructor(message, { status, body } = {}) {
        super(message);
        this.name = 'DiscordRestError';
        this.status = status;
        this.body = body;
    }
}

function createDiscordRestDelivery({ token, apiBaseUrl = DEFAULT_API_BASE_URL, fetchImpl = fetch } = {}) {
    const botToken = normalizeString(token);
    if (!botToken) {
        throw new Error('Discord REST delivery requires a bot token.');
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('Discord REST delivery requires a fetch implementation.');
    }

    const baseUrl = normalizeString(apiBaseUrl).replace(/\/$/, '');

    const request = async (path, body) => {
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method: 'POST',
            headers: {
                authorization: `Bot ${botToken}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const responseText = await response.text();
        let parsedBody = null;
        if (responseText) {
            try {
                parsedBody = JSON.parse(responseText);
            } catch (error) {
                parsedBody = { raw: responseText };
            }
        }
        if (!response.ok) {
            const errorCode = parsedBody?.code ? ` code=${parsedBody.code}` : '';
            throw new DiscordRestError(`Discord REST request failed: ${response.status}${errorCode}`, {
                status: response.status,
                body: parsedBody,
            });
        }
        return parsedBody;
    };

    const sendChannelMessage = async (channelId, content) => {
        const normalizedChannelId = normalizeString(channelId);
        if (!normalizedChannelId) {
            throw new Error('channel_id is required for Discord REST message delivery.');
        }
        return request(`/channels/${encodeURIComponent(normalizedChannelId)}/messages`, { content });
    };

    const openDmChannel = async (userId) => {
        const normalizedUserId = normalizeString(userId);
        if (!normalizedUserId) {
            throw new Error('user_id is required for Discord REST DM delivery.');
        }
        const channel = await request('/users/@me/channels', { recipient_id: normalizedUserId });
        if (!channel?.id) {
            throw new DiscordRestError('Discord REST create DM response did not include a channel id.', { body: channel });
        }
        return channel;
    };

    return {
        users: {
            fetch: async (userId) => ({
                send: async (content) => {
                    const channel = await openDmChannel(userId);
                    logger.debug({ userId, channelId: channel.id }, '[discord-rest] opened DM channel for reminder delivery');
                    return sendChannelMessage(channel.id, content);
                },
            }),
        },
        channels: {
            fetch: async (channelId) => ({
                send: async (content) => sendChannelMessage(channelId, content),
            }),
        },
    };
}

module.exports = {
    DEFAULT_API_BASE_URL,
    DiscordRestError,
    createDiscordRestDelivery,
};
