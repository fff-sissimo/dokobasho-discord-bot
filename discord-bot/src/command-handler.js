const logger = require('./logger');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { v4: uuidv4 } = require('uuid');
const chrono = require('chrono-node');
const { 
    getSheetsClient,
    getReminderByKey,
    getReminderById,
    addReminder,
    listReminders,
    deleteReminderById
} = require('./google-sheets');
const { resolveTimezone, adjustDateForTimezone } = require('./timezone');
const { MESSAGES } = require('./message-templates');
const { generateReminderKey } = require('./reminder-key');

const CONTENT_PREVIEW_LENGTH = 30;
const MAX_KEY_ATTEMPTS = 5;

async function generateUniqueReminderKey(scope) {
    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
        const candidate = generateReminderKey();
        const existing = await getReminderByKey(candidate, scope);
        if (!existing) {
            return candidate;
        }
    }
    throw new Error('Failed to generate unique reminder key.');
}

// --- Command Handler Logic ---
async function handleCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    try {
        await getSheetsClient(); // Check for config early

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'add') {
            const time = interaction.options.getString('time');
            const content = interaction.options.getString('content');
            const scope = interaction.options.getString('scope') ?? 'user';
            const visibility = interaction.options.getString('visibility') ?? (scope === 'user' ? 'ephemeral' : 'public');
            const recurring = interaction.options.getString('recurring') ?? 'off';
            const timezone = interaction.options.getString('timezone');
            const targetChannel = interaction.options.getChannel('channel');
            const referenceInstant = new Date();
            const resolvedTimezone = resolveTimezone(timezone, referenceInstant);
            if (resolvedTimezone.error) {
                await interaction.editReply({ content: resolvedTimezone.error });
                return;
            }

            const hasAdminPermission = Boolean(interaction.member?.permissions?.has('Administrator'));
            if (scope === 'server' && !hasAdminPermission) {
                await interaction.editReply({ content: MESSAGES.responses.adminRequiredForCreate });
                return;
            }
            if (scope === 'server' && !targetChannel) {
                await interaction.editReply({ content: MESSAGES.responses.channelRequiredForServerScope });
                return;
            }

            let parsedDate = chrono.parseDate(
                time,
                { instant: referenceInstant, timezone: resolvedTimezone.offset },
                { forwardDate: true }
            );
            if (!parsedDate) {
                await interaction.editReply({ content: MESSAGES.errors.invalidTime });
                return;
            }
            if (resolvedTimezone.source === 'iana') {
                parsedDate = adjustDateForTimezone(
                    parsedDate,
                    resolvedTimezone.label,
                    resolvedTimezone.offset
                );
            }

            const channelId = scope === 'server' ? targetChannel?.id : (scope === 'channel' ? interaction.channel?.id : null);
            const displayDate = `<t:${Math.floor(parsedDate.getTime() / 1000)}:F>`;
            const key = await generateUniqueReminderKey(scope);
            const newReminder = { id: uuidv4(), key, content, scope, guild_id: interaction.guild?.id, channel_id: channelId, user_id: interaction.user.id, notify_time_utc: parsedDate.toISOString(), timezone: resolvedTimezone.label, recurring, visibility, created_by: interaction.user.id, created_at: new Date().toISOString(), status: 'pending', last_sent: '', retry_count: 0, metadata: '{}' };
            await addReminder(newReminder);
            await interaction.editReply({ content: MESSAGES.responses.created(key, displayDate), ephemeral: visibility === 'ephemeral' });

        } else if (subcommand === 'get') {
            await interaction.editReply({ content: MESSAGES.responses.getDisabled });

        } else if (subcommand === 'list') {
            const scope = interaction.options.getString('scope');
            const query = interaction.options.getString('query');
            const limit = interaction.options.getInteger('limit') ?? 50;
            const reminders = await listReminders(scope, { userId: interaction.user.id, channelId: interaction.channel?.id, guildId: interaction.guild?.id });
            if (reminders.length === 0) {
                await interaction.editReply({ content: MESSAGES.responses.listEmpty });
                return;
            }
            const filteredReminders = query ? reminders.filter(r => r.key.includes(query) || r.content.includes(query)) : reminders;
            const listContent = filteredReminders.slice(0, limit).map(r => {
                const notifyTime = new Date(r.notify_time_utc);
                const displayDate = `<t:${Math.floor(notifyTime.getTime() / 1000)}:R>`;
                const contentPreview = r.content.substring(0, CONTENT_PREVIEW_LENGTH);
                return MESSAGES.responses.listItem(r.key, contentPreview, displayDate);
            }).join('\n');
            const total = filteredReminders.length;
            const displayed = Math.min(limit, total);
            await interaction.editReply({ content: MESSAGES.responses.listHeader(scope, total, displayed, listContent), ephemeral: true });


        } else if (subcommand === 'delete') {
            const key = interaction.options.getString('key');
            const scope = interaction.options.getString('scope');
            const confirm = interaction.options.getBoolean('confirm') ?? false;

            if (scope === 'server' && !interaction.member?.permissions?.has('Administrator')) {
                 await interaction.editReply({ content: MESSAGES.responses.adminRequiredForDelete });
                 return;
            }
            const reminder = await getReminderByKey(key, scope);
            if (!reminder) {
                await interaction.editReply({ content: MESSAGES.responses.notFound });
                return;
            }

            if (confirm) {
                const deleteResult = await deleteReminderById(reminder.id);
                if (!deleteResult || deleteResult.alreadyDeleted) {
                    await interaction.editReply({ content: MESSAGES.responses.alreadyDeleted });
                    return;
                }
                await interaction.editReply({ content: MESSAGES.responses.deleteSuccess(key) });
            } else {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`delete-confirm_${reminder.id}`).setLabel(MESSAGES.responses.deleteConfirmLabel).setStyle(ButtonStyle.Danger),
                );
                await interaction.editReply({ content: MESSAGES.responses.deleteConfirm(key), components: [row] });
            }
        }
    } catch (error) {
        logger.error({ 
            error: error.message, 
            stack: error.stack, 
            command: interaction.commandName, 
            subcommand: interaction.options.getSubcommand(),
            userId: interaction.user.id,
            guildId: interaction.guild?.id
        }, 'Error in handleCommand');
        throw error; // Re-throw the error to be caught by the main interaction handler
    }
}
// --- End Command Handler Logic ---


// --- Button Handler Logic ---
async function handleButton(interaction) {
    await interaction.deferUpdate(); // Acknowledge the button press
    
    try {
        const [_, reminderId] = interaction.customId.split('_');
        if (!reminderId) throw new Error('Invalid customId for delete button.');

        const reminder = await getReminderById(reminderId);
        if (!reminder) {
            await interaction.editReply({ content: MESSAGES.responses.alreadyDeleted, components: [] });
            return;
        }
        
        if (reminder.scope === 'server' && !interaction.member?.permissions?.has('Administrator')) {
            await interaction.editReply({ content: MESSAGES.responses.adminRequiredForDelete, components: [] });
            return;
        }

        const deleteResult = await deleteReminderById(reminder.id);
        if (!deleteResult || deleteResult.alreadyDeleted) {
            await interaction.editReply({ content: MESSAGES.responses.alreadyDeleted, components: [] });
            return;
        }
        await interaction.editReply({ content: MESSAGES.responses.deleteSuccess(reminder.key), components: [] });

    } catch (error) {
        logger.error({ 
            error: error.message, 
            stack: error.stack, 
            customId: interaction.customId,
            userId: interaction.user.id,
            guildId: interaction.guild?.id
        }, 'Error in handleButton');
        throw error; // Re-throw the error
    }
}
// --- End Button Handler Logic ---


module.exports = {
    handleCommand,
    handleButton,
};
