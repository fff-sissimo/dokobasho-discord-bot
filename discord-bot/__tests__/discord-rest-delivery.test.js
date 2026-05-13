const { createDiscordRestDelivery, DiscordRestError } = require('../src/discord-rest-delivery');

const jsonResponse = (body, init = {}) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
});

describe('discord REST delivery adapter', () => {
    it('sends a channel message with bot token auth', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ id: 'message-1' }));
        const client = createDiscordRestDelivery({ token: 'bot-token', fetchImpl });

        const channel = await client.channels.fetch('channel-1');
        await channel.send('hello');

        expect(fetchImpl).toHaveBeenCalledWith('https://discord.com/api/v10/channels/channel-1/messages', {
            method: 'POST',
            headers: {
                authorization: 'Bot bot-token',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ content: 'hello' }),
        });
    });

    it('opens a DM channel before sending a user message', async () => {
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(jsonResponse({ id: 'dm-channel-1' }))
            .mockResolvedValueOnce(jsonResponse({ id: 'message-1' }));
        const client = createDiscordRestDelivery({ token: 'bot-token', fetchImpl });

        const user = await client.users.fetch('user-1');
        await user.send('reminder');

        expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://discord.com/api/v10/users/@me/channels', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ recipient_id: 'user-1' }),
        }));
        expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://discord.com/api/v10/channels/dm-channel-1/messages', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ content: 'reminder' }),
        }));
    });

    it('raises a typed error for non-2xx Discord responses', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ code: 50001, message: 'Missing Access' }, { ok: false, status: 403 }));
        const client = createDiscordRestDelivery({ token: 'bot-token', fetchImpl });
        const channel = await client.channels.fetch('channel-1');

        let caught;
        try {
            await channel.send('hello');
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(DiscordRestError);
        expect(caught).toMatchObject({
            name: 'DiscordRestError',
            status: 403,
            body: { code: 50001, message: 'Missing Access' },
        });
    });
});
