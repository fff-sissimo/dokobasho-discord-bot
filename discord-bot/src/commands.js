const { MESSAGES } = require('./message-templates');

const remindMessages = MESSAGES.commands.remind;
const fairyMessages = MESSAGES.commands.fairy;

const commands = [
    {
        name: 'remind',
        description: remindMessages.description,
        options: [
            {
                name: 'add',
                description: remindMessages.add.description,
                type: 1,
                options: [
                    {
                        name: 'time',
                        description: remindMessages.add.options.time,
                        type: 3,
                        required: true,
                    },
                    {
                        name: 'content',
                        description: remindMessages.add.options.content,
                        type: 3,
                        required: true,
                    },
                    {
                        name: 'scope',
                        description: remindMessages.add.options.scope,
                        type: 3,
                        required: false,
                        choices: [
                            { name: remindMessages.add.choices.scope.user, value: 'user' },
                            { name: remindMessages.add.choices.scope.channel, value: 'channel' },
                            { name: remindMessages.add.choices.scope.server, value: 'server' },
                        ],
                    },
                    {
                        name: 'channel',
                        description: remindMessages.add.options.channel,
                        type: 7,
                        required: false,
                        channel_types: [0],
                    },
                    {
                        name: 'visibility',
                        description: remindMessages.add.options.visibility,
                        type: 3,
                        required: false,
                        choices: [
                            { name: remindMessages.add.choices.visibility.ephemeral, value: 'ephemeral' },
                            { name: remindMessages.add.choices.visibility.public, value: 'public' },
                        ],
                    },
                    {
                        name: 'recurring',
                        description: remindMessages.add.options.recurring,
                        type: 3,
                        required: false,
                        choices: [
                            { name: remindMessages.add.choices.recurring.off, value: 'off' },
                            { name: remindMessages.add.choices.recurring.daily, value: 'daily' },
                            { name: remindMessages.add.choices.recurring.weekly, value: 'weekly' },
                            { name: remindMessages.add.choices.recurring.monthly, value: 'monthly' },
                        ],
                    },
                    {
                        name: 'timezone',
                        description: remindMessages.add.options.timezone,
                        type: 3,
                        required: false,
                    },
                ],
            },
            {
                name: 'list',
                description: remindMessages.list.description,
                type: 1,
                options: [
                    {
                        name: 'scope',
                        description: remindMessages.list.options.scope,
                        type: 3,
                        required: true,
                        choices: [
                            { name: remindMessages.list.choices.scope.user, value: 'user' },
                            { name: remindMessages.list.choices.scope.channel, value: 'channel' },
                            { name: remindMessages.list.choices.scope.server, value: 'server' },
                        ],
                    },
                    {
                        name: 'query',
                        description: remindMessages.list.options.query,
                        type: 3,
                        required: false,
                    },
                    {
                        name: 'limit',
                        description: remindMessages.list.options.limit,
                        type: 4,
                        required: false,
                    },
                ],
            },
            {
                name: 'delete',
                description: remindMessages.delete.description,
                type: 1,
                options: [
                    {
                        name: 'key',
                        description: remindMessages.delete.options.key,
                        type: 3,
                        required: true,
                    },
                    {
                        name: 'scope',
                        description: remindMessages.delete.options.scope,
                        type: 3,
                        required: true,
                        choices: [
                            { name: remindMessages.delete.choices.scope.user, value: 'user' },
                            { name: remindMessages.delete.choices.scope.channel, value: 'channel' },
                            { name: remindMessages.delete.choices.scope.server, value: 'server' },
                        ],
                    },
                    {
                        name: 'confirm',
                        description: remindMessages.delete.options.confirm,
                        type: 5,
                        required: false,
                    },
                ],
            },
        ],
    },
    {
        name: 'fairy',
        description: fairyMessages.description,
        options: [
            {
                name: 'request',
                description: fairyMessages.options.request,
                type: 3,
                required: false,
            },
        ],
    },
];

module.exports = commands;
