const logger = require('./logger');
const { getPendingReminders, updateReminder } = require('./google-sheets');
const { calculateNextDate } = require('./utils');
const { MESSAGES } = require('./message-templates');

/**
 * Processes pending reminders, sends notifications, and updates their status.
 * @param {import('discord.js').Client} discordClient - The Discord client instance.
 */
async function processReminders(discordClient) {
    logger.debug('Checking for pending reminders...');

    const reminders = await getPendingReminders();
    const result = { processed: reminders.length, sent: 0, failed: 0 };

    if (reminders.length === 0) {
        logger.debug('No reminders due.');
        return result;
    }

    logger.info(`Found ${reminders.length} reminders to process.`);

    for (const reminder of reminders) {
        const rowIndex = reminder.rowIndex;
        try {
            // 1. Pessimistic Lock: Mark as 'sending'
            await updateReminder(reminder.id, { status: 'sending', last_sent: new Date().toISOString() }, { rowIndex });
            logger.debug({ reminderId: reminder.id }, 'Locked reminder.');

            // 2. Send notification
            const message = MESSAGES.reminders.notification(reminder.content);
            if (reminder.scope === 'user') {
                const user = await discordClient.users.fetch(reminder.user_id);
                if (!user) throw new Error('Discord user not found for reminder delivery.');
                await user.send(message);
            } else if (reminder.scope === 'channel') {
                const channel = await discordClient.channels.fetch(reminder.channel_id);
                if (!channel) throw new Error('Discord channel not found for reminder delivery.');
                await channel.send(message);
            } else if (reminder.scope === 'server') {
                if (!reminder.channel_id) throw new Error('Server-scoped reminder has no delivery channel.');
                const channel = await discordClient.channels.fetch(reminder.channel_id);
                if (!channel) throw new Error('Discord channel not found for server reminder delivery.');
                await channel.send(message);
            } else {
                throw new Error(`Unsupported reminder scope: ${String(reminder.scope)}`);
            }
            logger.info({ reminderId: reminder.id }, 'Sent notification.');
            result.sent += 1;

            // 3. Update status after sending
            if (reminder.recurring !== 'off') {
                const nextTime = calculateNextDate(reminder.notify_time_utc, reminder.recurring);
                await updateReminder(reminder.id, {
                    notify_time_utc: nextTime,
                    status: 'pending', // Reschedule
                    last_sent: new Date().toISOString(),
                }, { rowIndex });
                logger.debug({ reminderId: reminder.id }, 'Rescheduled reminder.');
            } else {
                await updateReminder(reminder.id, {
                    status: 'sent',
                    last_sent: new Date().toISOString(),
                }, { rowIndex });
                logger.debug({ reminderId: reminder.id }, 'Marked reminder as sent.');
            }
        } catch (error) {
            result.failed += 1;
            logger.error({ reminderId: reminder.id, err: error }, 'Failed to process reminder.');
            // Revert status to pending for retry, increment retry count
            const retryCount = parseInt(reminder.retry_count || '0', 10) + 1;
            const newStatus = retryCount >= 3 ? 'failed' : 'pending';
            
            if (newStatus === 'failed') {
                logger.error({ reminderId: reminder.id }, `Reminder has failed ${retryCount} times. Setting status to "failed".`);
            }
            
            await updateReminder(reminder.id, {
                status: newStatus,
                retry_count: retryCount,
            }, { rowIndex }).catch(err => {
                logger.error({ reminderId: reminder.id, err }, 'CRITICAL: Failed to update status for reminder after send failure.');
            });
        }
    }

    return result;
}

module.exports = { processReminders };
