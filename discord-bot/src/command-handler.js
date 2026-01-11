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
    deleteReminderById,
    updateReminder
} = require('./google-sheets');


// --- Command Handler Logic ---
async function handleCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    try {
        await getSheetsClient(); // Check for config early

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'add') {
            const key = interaction.options.getString('key');
            const time = interaction.options.getString('time');
            const content = interaction.options.getString('content');
            const scope = interaction.options.getString('scope') ?? 'user';
            const visibility = interaction.options.getString('visibility') ?? (scope === 'user' ? 'ephemeral' : 'public');
            const recurring = interaction.options.getString('recurring') ?? 'off';
            const timezone = interaction.options.getString('timezone');
            const overwrite = interaction.options.getBoolean('overwrite') ?? false;
            const targetChannel = interaction.options.getChannel('channel');

            const hasAdminPermission = Boolean(interaction.member?.permissions?.has('Administrator'));
            if (scope === 'server' && !hasAdminPermission) {
                await interaction.editReply({ content: 'サーバー全体のリマインダーを作成するには、管理者権限が必要です。' });
                return;
            }
            if (scope === 'server' && !targetChannel) {
                await interaction.editReply({ content: 'サーバー全体のリマインダーは通知先チャンネルの指定が必要です。' });
                return;
            }

            const parsedDate = chrono.parseDate(time, { timezone, forwardDate: true });
            if (!parsedDate) {
                await interaction.editReply({ content: `❌ 時刻の指定が正しくありません。「明日の10時」や「2026-01-11 15:00」のように指定してください。` });
                return;
            }

            const existing = await getReminderByKey(key, scope);
            if (existing && !overwrite) {
                await interaction.editReply({ content: `❌ 同じキーのリマインダーが既に存在します (\`key: ${key}\`, \`scope: ${scope}\`)。\n上書きする場合は \`overwrite\` オプションをtrueにしてください。` });
                return;
            }

            const channelId = scope === 'server' ? targetChannel?.id : (scope === 'channel' ? interaction.channel?.id : null);
            const displayDate = `<t:${Math.floor(parsedDate.getTime() / 1000)}:F>`;

            if (existing && overwrite) {
                await updateReminder(existing.id, {
                    content,
                    scope,
                    guild_id: interaction.guild?.id,
                    channel_id: channelId,
                    user_id: interaction.user.id,
                    notify_time_utc: parsedDate.toISOString(),
                    timezone: timezone ?? 'Asia/Tokyo',
                    recurring,
                    visibility,
                    status: 'pending',
                    last_sent: '',
                    retry_count: 0,
                    metadata: '{}',
                }, { rowIndex: existing.rowIndex });
                await interaction.editReply({ content: `✅ リマインダーを更新しました！\n**キー:** ${key}\n**次回通知:** ${displayDate}`, ephemeral: visibility === 'ephemeral' });
            } else {
                const newReminder = { id: uuidv4(), key, content, scope, guild_id: interaction.guild?.id, channel_id: channelId, user_id: interaction.user.id, notify_time_utc: parsedDate.toISOString(), timezone: timezone ?? 'Asia/Tokyo', recurring, visibility, created_by: interaction.user.id, created_at: new Date().toISOString(), status: 'pending', last_sent: '', retry_count: 0, metadata: '{}' };
                await addReminder(newReminder);
                await interaction.editReply({ content: `✅ リマインダーを登録しました！\n**キー:** ${key}\n**次回通知:** ${displayDate}`, ephemeral: visibility === 'ephemeral' });
            }

        } else if (subcommand === 'get') {
            const key = interaction.options.getString('key');
            const scope = interaction.options.getString('scope');
            const reminder = await getReminderByKey(key, scope);
            if (!reminder) {
                await interaction.editReply({ content: '該当するリマインダーは見つかりませんでした。' });
                return;
            }
            const notifyTime = new Date(reminder.notify_time_utc);
            const displayDate = `<t:${Math.floor(notifyTime.getTime() / 1000)}:F>`;
            await interaction.editReply({ content: `**リマインダー詳細**\n- **キー:** ${reminder.key}\n- **スコープ:** ${reminder.scope}\n- **次回通知:** ${displayDate}\n- **繰り返し:** ${reminder.recurring}\n- **内容:** ${reminder.content}`, ephemeral: true });

        } else if (subcommand === 'list') {
            const scope = interaction.options.getString('scope');
            const query = interaction.options.getString('query');
            const limit = interaction.options.getInteger('limit') ?? 50;
            const reminders = await listReminders(scope, { userId: interaction.user.id, channelId: interaction.channel?.id, guildId: interaction.guild?.id });
            if (reminders.length === 0) {
                await interaction.editReply({ content: '登録されているリマインダーはありません。' });
                return;
            }
            const filteredReminders = query ? reminders.filter(r => r.key.includes(query) || r.content.includes(query)) : reminders;
            const listContent = filteredReminders.slice(0, limit).map(r => {
                const notifyTime = new Date(r.notify_time_utc);
                const displayDate = `<t:${Math.floor(notifyTime.getTime() / 1000)}:R>`;
                return `- \`${r.key}\`: ${r.content.substring(0, 30)}... (通知: ${displayDate})`;
            }).join('\n');
            const total = filteredReminders.length;
            await interaction.editReply({ content: `**リマインダー一覧 (${scope}) - ${total}件中${Math.min(limit, total)}件表示**\n${listContent}`, ephemeral: true });


        } else if (subcommand === 'delete') {
            const key = interaction.options.getString('key');
            const scope = interaction.options.getString('scope');
            const confirm = interaction.options.getBoolean('confirm') ?? false;

            if (scope === 'server' && !interaction.member?.permissions?.has('Administrator')) {
                 await interaction.editReply({ content: 'サーバー全体のリマインダーを削除するには、管理者権限が必要です。' });
                 return;
            }
            const reminder = await getReminderByKey(key, scope);
            if (!reminder) {
                await interaction.editReply({ content: '該当するリマインダーは見つかりませんでした。' });
                return;
            }

            if (confirm) {
                const deleteResult = await deleteReminderById(reminder.id);
                if (!deleteResult || deleteResult.alreadyDeleted) {
                    await interaction.editReply({ content: 'このリマインダーは既に削除されているようです。' });
                    return;
                }
                await interaction.editReply({ content: `✅ リマインダー「${key}」を削除しました。` });
            } else {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`delete-confirm_${reminder.id}`).setLabel('はい、削除します').setStyle(ButtonStyle.Danger),
                );
                await interaction.editReply({ content: `本当にリマインダー「${key}」を削除しますか？この操作は取り消せません。`, components: [row] });
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
            await interaction.editReply({ content: 'このリマインダーは既に削除されているようです。', components: [] });
            return;
        }
        
        if (reminder.scope === 'server' && !interaction.member?.permissions?.has('Administrator')) {
            await interaction.editReply({ content: 'サーバー全体のリマインダーを削除するには、管理者権限が必要です。', components: [] });
            return;
        }

        const deleteResult = await deleteReminderById(reminder.id);
        if (!deleteResult || deleteResult.alreadyDeleted) {
            await interaction.editReply({ content: 'このリマインダーは既に削除されているようです。', components: [] });
            return;
        }
        await interaction.editReply({ content: `✅ リマインダー「${reminder.key}」を削除しました。`, components: [] });

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
