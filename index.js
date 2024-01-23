import dotenv from 'dotenv';
dotenv.config();
import TelegramBot from 'node-telegram-bot-api';
import { toHTML } from '@telegraf/entity';
import OpenAI, { NotFoundError } from 'openai';
import { connectToDatabase } from './db.js';
import botConstants from './constants.js';
import parseChannels from './parseChannels.js';

(async () => {
  const tgBot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
  const clients = [];
  const dbClient = await connectToDatabase();
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  parseChannels(dbClient);

  tgBot.on('message', async (message) => {
    const text = message.text;
    if (text === '/start') {
      const chatId = message.chat.id;
      const userName = message.chat.username;
      const client = clients.find((client) => client.id == chatId);

      if (!client) {
        const botInstance = new Bot(tgBot, dbClient, chatId, openai);
        const client = {
          id: chatId,
          username: userName,
          botInstance: botInstance,
        };

        clients.push(client);
      }
    }
  });
})();

class Bot {
  constructor(tgBot, dbClient, chatId, openai) {
    this.tgBot = tgBot;
    this.dbClient = dbClient;
    this.chatId = chatId;
    this.openai = openai;
    this.sendedPostMessages = [];
    this.sendedMediaItemsForDelete = [];
    this.afterEditHistory = [];
    this.gptMessages = [];
    this.currentEditingPostLink = null;
    this.currentPublishChannel = null;
    this.globalMsg = null;
    this.commandsHandler = new CommandsHandler(this.tgBot, this.dbClient, this.chatId);
    this.state = {
      page: 'startPage', // ['startPage', 'editPostPage', 'publishScreen', 'gptPage']
      active: true,
      isSenderBlocked: false,
    };

    this.build();
  }

  async build() {
    this.db = await this.dbClient.db('tg_repost_bot2');

    const currentConnection = await this.db
      .collection('connections')
      .findOne({ chatId: this.chatId });
    if (!currentConnection) {
      const connection = {
        chatId: this.chatId,
        posts: [],
      };

      await this.db.collection('connections').insertOne(connection);
    }

    this.commandsHandler.sendStartPageMsg();
    this.createEvents();
    this.loopPostSender();
  }

  async loopPostSender() {
    if (!this.state.active || this.state.isSenderBlocked) {
      setTimeout(() => {
        this.loopPostSender();
      }, 1000 * 10);
      return;
    }

    const currentConnection = await this.db
      .collection('connections')
      .findOne({ chatId: this.chatId });
    const posts = currentConnection.posts;
    const postsToSend = posts.filter((post) => !post.sended && !post.deleted);

    // console.log(postsToSend, 'postsToSend');

    for (const post of postsToSend) {
      await this.sendPost(post);
      if (!this.state.active || this.state.isSenderBlocked) {
        setTimeout(() => {
          this.loopPostSender();
        }, 1000 * 10);
        return;
      }
      await this.delay(5);
    }

    setTimeout(() => {
      this.loopPostSender();
    }, 1000 * 10);
  }

  sendPost(post) {
    return new Promise(async (resolve, reject) => {
      if (!this.state.active || this.state.isSenderBlocked) {
        resolve(true);
        return;
      }

      try {
        if (post.media.length) {
          const mediaGroup = [];
          post.media.forEach((media) => {
            const type = botConstants.mediaTypes[media['type']];
            const url = media.url;

            const mediaObj = {
              type,
              media: url,
            };

            mediaGroup.push(mediaObj);
          });

          const msg1 = await this.tgBot.sendMediaGroup(this.chatId, mediaGroup);
          this.sendedPostMessages.push(msg1);
          let description = post.description;
          description = description.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '');
          description = description.replaceAll('<br/>', '');
          description = description.replaceAll('<br />', '');
          description = description.replaceAll('</br>', '');
          description = description.replace(/<img[^>]*>/g, '');
          description = description.replace(/<a\s*[^>]*><\/a>/g, '');
          description = description.trim();

          const msg2 = await this.tgBot.sendMessage(
            this.chatId,
            `<a href="${post.channelLink}">@${post.channelNickname}</a>\n\n${description}`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: 'Редактировать ✏️', callback_data: `edit_post::${post.link}` },
                    { text: 'Удалить ❌', callback_data: `delete_post::${post.link}` },
                  ],
                ],
              },
            },
          );
          this.sendedPostMessages.push(msg2);
        } else {
          let description = post.description;
          description = description.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '');
          description = description.replaceAll('<br/>', '');
          description = description.replaceAll('<br />', '');
          description = description.replaceAll('</br>', '');
          description = description.replace(/<img[^>]*>/g, '');
          description = description.replace(/<a\s*[^>]*><\/a>/g, '');
          description = description.trim();

          const msg3 = await this.tgBot.sendMessage(
            this.chatId,
            `<a href="${post.channelLink}">@${post.channelNickname}</a>\n\n${description}`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: 'Редактировать ✏️', callback_data: `edit_post::${post.link}` },
                    { text: 'Удалить ❌', callback_data: `delete_post::${post.link}` },
                  ],
                ],
              },
            },
          );
          this.sendedPostMessages.push(msg3);
        }

        await this.setPostIsSended(post);
        resolve(true);
      } catch (error) {
        const errorCode = error?.response?.body?.error_code;
        if (errorCode === 400) {
          await this.setPostIsSended(post)
        }
        console.log(error?.response?.body);
        resolve(true);
      }
    });
  }

  createEvents() {
    this.tgBot.on('message', async (message) => {
      if (this.chatId !== message.from.id) return;
      if (this.state.page !== 'startPage') {
        this.afterEditHistory.push(message);
      }

      const text = message.text;
      const repliedMessage = message['reply_to_message'];

      if (repliedMessage) {
        const repliedText = repliedMessage.text;
        let status;

        switch (repliedText) {
          case botConstants.messages.updateSubscribedChannels:
            const subscribedChannels = text.split('\n');
            status = await this.handleSaveSubcribedChannels(subscribedChannels);
            if (status.ok) {
              this.commandsHandler.sendSuccessfullyUpdatedSubscribedChannels();
            } else {
              this.commandsHandler.sendErrorUpdatedSubscribedChannels(status.error);
            }
            break;

          case botConstants.messages.delayMessage:
            const hours = +text.split(':')[0];
            const minutes = +text.split(':')[1];
            const seconds = hours * 60 * 60 + minutes * 60;
            this.delayPostPublish(seconds);
            this.globalMsg = await this.sendSimpleMessage(
              botConstants.messages.successDelayMessage,
              botConstants.markups.publishPostMarkup,
            );
            this.afterEditHistory.push(this.globalMsg);
            setTimeout(() => {
              this.goToStartScreen();
            }, 2000);
            break;

          case botConstants.messages.updateMyChannels:
            const myChannels = text.split('\n');
            status = await this.handleSaveMyChannels(myChannels);
            if (status.ok) {
              this.commandsHandler.sendSuccessfullyUpdatedMyChannels();
            } else {
              this.commandsHandler.sendErrorUpdatedMyChannels(status.error);
            }
            break;

          case botConstants.messages.editText:
            const formattedHTMLMsg = toHTML({ text: text, entities: message.entities || [] });
            status = await this.handleEditText(formattedHTMLMsg);
            if (status.ok) {
              this.globalMsg = await this.commandsHandler.sendSuccessfullyEditedText();
              this.afterEditHistory.push(this.globalMsg);
              await this.goToEditingScreen(this.currentEditingPostLink);
            } else {
              this.globalMsg = await this.commandsHandler.sendErrorEditedText(status.error);
              this.afterEditHistory.push(this.globalMsg);
            }
            break;

          case botConstants.messages.editTextOnGPT:
            const formattedHTMLMsgGPT = toHTML({ text: text, entities: message.entities || [] });
            status = await this.handleEditText(formattedHTMLMsgGPT);
            if (status.ok) {
              this.globalMsg = await this.sendSimpleMessage(
                botConstants.messages.textSuccessEditedOnGPT,
                botConstants.markups.chatGPTMarkup,
              );
              this.afterEditHistory.push(this.globalMsg);
            } else {
              this.globalMsg = await this.sendSimpleMessage(
                botConstants.messages.textErrorEditedOnGPT,
                botConstants.markups.chatGPTMarkup,
              );
              this.afterEditHistory.push(this.globalMsg);
            }
            break;

          default:
            break;
        }

        return;
      }

      if ((message.photo || message.video) && this.state.page === 'editPostPage') {
        const media = message.photo ? message.photo[0] : message.video;

        const newMedia = {
          uuid: 'xxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)),
          url: media.file_id,
          type: message.photo ? 'image/jpeg' : 'video/mp4',
          length: +media.file_size,
        };

        await this.addNewMediaItem(newMedia);
        await this.goToEditingScreen(this.currentEditingPostLink);
        return;
      }

      switch (text) {
        case '/start':
          this.goToStartScreen();
          break;

        // start page
        case botConstants.commands.updateSubscribedChannels:
          if (this.state.page !== 'startPage') return;
          this.commandsHandler.sendUpdateSubscribedChannels();
          break;

        case botConstants.commands.showSubscribedChannels:
          if (this.state.page !== 'startPage') return;
          this.commandsHandler.sendSubscribedChannels();
          break;

        case botConstants.commands.updateMyChannels:
          if (this.state.page !== 'startPage') return;
          this.commandsHandler.sendUpdateMyChannels();
          break;

        case botConstants.commands.showMyChannels:
          if (this.state.page !== 'startPage') return;
          this.commandsHandler.sendMyChannels();
          break;

        case botConstants.commands.startWatcher:
          if (this.state.page !== 'startPage') return;
          this.state.active = true;
          this.commandsHandler.startWatcherMessage();
          break;

        case botConstants.commands.stopWatcher:
          if (this.state.page !== 'startPage') return;
          this.state.active = false;
          this.commandsHandler.stopWatcherMessage();
          break;

        case botConstants.commands.clearDatabase:
          if (this.state.page !== 'startPage') return;
          await this.handleClearOldPosts();
          break;

        // editing page
        case botConstants.commands.editText:
          if (this.state.page !== 'editPostPage') return;
          this.globalMsg = await this.commandsHandler.sendEditTextMessage();
          this.afterEditHistory.push(this.globalMsg);
          break;

        case botConstants.commands.addSubcribe:
          if (this.state.page !== 'editPostPage') return;
          this.globalMsg = await this.sendAddSubscribeMessage();
          this.afterEditHistory.push(this.globalMsg);
          break;

        case botConstants.commands.publishPost:
          if (this.state.page !== 'editPostPage') return;
          await this.goToPublishScreen();
          break;

        case botConstants.commands.editMedia:
          if (this.state.page !== 'editPostPage') return;
          await this.handleEditMediaButtonClick();
          break;

        case botConstants.commands.goToGPT:
          if (this.state.page !== 'editPostPage') return;
          await this.goToGPT();
          break;

        // publishing page
        case botConstants.commands.publishNow:
          if (this.state.page !== 'publishScreen') return;
          await this.handlePublishNow();
          break;

        case botConstants.commands.delayPublish:
          if (this.state.page !== 'publishScreen') return;
          await this.handleDelayMessageClick();
          break;

        case botConstants.commands.changePublishChannel:
          if (this.state.page !== 'publishScreen') return;
          const myChanels = await this.getMyChannels();
          this.globalMsg = await this.sendMessageWithChoseChannel(myChanels);
          this.afterEditHistory.push(this.globalMsg);
          break;

        // gpt page
        case botConstants.commands.editOnGPTPage:
          if (this.state.page !== 'gptPage') return;
          this.globalMsg = await this.tgBot.sendMessage(
            this.chatId,
            botConstants.messages.editTextOnGPT,
            {
              parse_mode: 'HTML',
              reply_markup: JSON.stringify({ force_reply: true }),
            },
          );
          this.afterEditHistory.push(this.globalMsg);
          break;

        case botConstants.commands.updateContext:
          if (this.state.page !== 'gptPage') return;
          this.gptMessages = [];
          this.globalMsg = await this.sendSimpleMessage(
            botConstants.messages.contextUpdated,
            botConstants.markups.chatGPTMarkup,
          );
          this.afterEditHistory.push(this.globalMsg);
          break;

        case botConstants.commands.RephraseBOT:
          this.handleSendBindMessageToGpt(botConstants.commands.RephraseBOT);
          break;

        // back commands
        case botConstants.commands.back:
          switch (this.state.page) {
            case 'editPostPage':
              await this.goToStartScreen();
              break;

            case 'publishScreen':
              await this.goToEditingScreen(this.currentEditingPostLink);
              break;

            case 'gptPage':
              await this.goToEditingScreen(this.currentEditingPostLink);
              break;

            default:
              break;
          }

        default:
          break;
      }

      if (
        this.state.page === 'gptPage' &&
        text !== botConstants.commands.back &&
        text !== botConstants.commands.editOnGPTPage &&
        text !== botConstants.commands.goToGPT &&
        text !== botConstants.commands.updateContext &&
        text !== botConstants.commands.RephraseBOT
      ) {
        this.handleMessageToGPT(text);
      }
    });

    this.tgBot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;
      const callbackData = query.data;
      let msg;

      if (this.chatId !== chatId) return;

      const action = callbackData.split('::')[0];
      const data = callbackData.split('::')[1];
      let status;

      switch (action) {
        case botConstants.commands.deletePost:
          await this.setPostIsDeleted(data);
          await this.deleteMessageFromChat(messageId);
          break;

        case botConstants.commands.deleteMediaItem:
          await this.handleDeleteMediaItem(data);
          await this.deleteMediaItemFromChat(messageId);
          this.globalMsg = await this.sendSimpleMessage(
            botConstants.messages.mediaItemDeleted,
            botConstants.markups.editPostMarkup,
          );
          this.afterEditHistory.push(this.globalMsg);
          break;

        case botConstants.commands.editPost:
          this.goToEditingScreen(data);
          break;

        case botConstants.commands.chosePublishChannel:
          this.currentPublishChannel = data;
          this.globalMsg = await this.commandsHandler.sendPublishChannelChosen();
          this.afterEditHistory.push(this.globalMsg);
          break;

        case botConstants.commands.addSubscribeChannel:
          const currentPost = await this.getCurrentEditedPost();
          const newDescription = `${currentPost.description}\n\n@${data}`;
          const formattedHTMLMsg = toHTML({ text: newDescription });
          status = await this.handleEditText(formattedHTMLMsg);
          if (status.ok) {
            this.globalMsg = await this.commandsHandler.sendSuccessfullyEditedText();
            this.afterEditHistory.push(this.globalMsg);
            await this.goToEditingScreen(this.currentEditingPostLink);
          } else {
            this.globalMsg = await this.commandsHandler.sendErrorEditedText(status.error);
            this.afterEditHistory.push(this.globalMsg);
          }
          break;

        default:
          break;
      }
    });
  }

  async handleClearOldPosts() {
    await this.db.collection('connections').updateMany(
      { chatId: this.chatId },
      { $pull: { posts: { sended: true } } }
    );
    await this.sendSimpleMessage('Отправленные посты удаленны с базы данных.', botConstants.markups.startMarkup)
  }

  async handleSendBindMessageToGpt(msg) {
    const text = msg;
    try {
      switch (text) {
        case botConstants.commands.RephraseBOT:
          this.gptMessages.push({
            role: 'user',
            content: botConstants.bindedButtons.RephraseBOT,
          });
          this.globalMsg = await this.sendSimpleMessage(
            botConstants.bindedButtons.RephraseBOT,
            botConstants.markups.chatGPTMarkup,
          );
          this.afterEditHistory.push(this.globalMsg);
          break;

        default:
          break;
      }
      const completion = await this.openai.chat.completions.create({
        messages: this.gptMessages,
        model: 'gpt-4-1106-preview',
      });
      const result = completion.choices[0]['message']['content'];
      let msg = await this.sendSimpleMessage(result, botConstants.markups.chatGPTMarkup);
      this.afterEditHistory.push(msg);
      this.gptMessages.push({ role: 'assistant', content: result });
    } catch (error) {
      let msg = await this.sendSimpleMessage(`Ошибка ${error}`, botConstants.markups.chatGPTMarkup);
      this.afterEditHistory.push(msg);
      this.gptMessages = [];
    }
  }

  async handleMessageToGPT(text) {
    let msg = await this.sendSimpleMessage(
      botConstants.messages.waitGPT,
      botConstants.markups.chatGPTMarkup,
    );
    this.afterEditHistory.push(msg);
    try {
      this.gptMessages.push({ role: 'user', content: text });
      const completion = await this.openai.chat.completions.create({
        messages: this.gptMessages,
        model: 'gpt-4-1106-preview',
      });
      const result = completion.choices[0]['message']['content'];
      let msg = await this.sendSimpleMessage(result, botConstants.markups.chatGPTMarkup);
      this.afterEditHistory.push(msg);
      this.gptMessages.push({ role: 'assistant', content: result });
    } catch (error) {
      let msg = await this.sendSimpleMessage(`Ошибка ${error}`, botConstants.markups.chatGPTMarkup);
      this.afterEditHistory.push(msg);
      this.gptMessages = [];
    }
  }

  async goToGPT() {
    this.state.page = 'gptPage';
    this.gptMessages = [];
    this.state.isSenderBlocked = true;
    let msg = await this.sendSimpleMessage(
      botConstants.messages.currentPost,
      botConstants.markups.chatGPTMarkup,
    );
    this.afterEditHistory.push(msg);
    await this.sendPostWithoutButtons(this.currentEditingPostLink, 'chatGPTMarkup');
    this.globalMsg = await this.sendSimpleMessage(
      botConstants.messages.gptScreenTip,
      botConstants.markups.chatGPTMarkup,
    );
    this.afterEditHistory.push(this.globalMsg);
  }

  delayPostPublish(seconds) {
    const currentPostLink = this.currentEditingPostLink;
    const publishedChannel = this.currentPublishChannel;

    setTimeout(async () => {
      const currentConnection = await this.db
        .collection('connections')
        .findOne({ chatId: this.chatId });
      const posts = currentConnection.posts;
      const post = posts.find((post) => post.link == currentPostLink);

      try {
        if (post.media.length) {
          const mediaGroup = [];
          post.media.forEach((media) => {
            const type = botConstants.mediaTypes[media['type']];
            const url = media.url;

            const mediaObj = {
              type,
              media: url,
            };

            mediaGroup.push(mediaObj);
          });

          await this.tgBot.sendMediaGroup(`@${publishedChannel}`, mediaGroup);
          let description = post.description;
          description = description.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '');
          description = description.replaceAll('<br/>', '');
          description = description.replaceAll('<br />', '');
          description = description.replaceAll('</br>', '');
          description = description.replace(/<img[^>]*>/g, '');
          description = description.replace(/<a\s*[^>]*><\/a>/g, '');
          description = description.trim();

          if (!description) {
            description = 'Выберите действие:';
          }

          await this.tgBot.sendMessage(`@${publishedChannel}`, description, { parse_mode: 'HTML' });
        } else {
          let description = post.description;
          description = description.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '');
          description = description.replaceAll('<br/>', '');
          description = description.replaceAll('<br />', '');
          description = description.replaceAll('</br>', '');
          description = description.replace(/<img[^>]*>/g, '');
          description = description.replace(/<a\s*[^>]*><\/a>/g, '');
          description = description.trim();

          await this.tgBot.sendMessage(`@${publishedChannel}`, description, { parse_mode: 'HTML' });
        }
      } catch (error) {
        console.log(error);
      }
    }, 1000 * seconds);
  }

  async handleDelayMessageClick() {
    if (!this.currentPublishChannel) {
      const myChanels = await this.getMyChannels();
      let msg = await this.sendMessageWithChoseChannel(myChanels);
      this.afterEditHistory.push(msg);
    } else {
      let msg = await this.tgBot.sendMessage(this.chatId, botConstants.messages.delayMessage, {
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({ force_reply: true }),
      });
      this.afterEditHistory.push(msg);
      return msg;
    }
  }

  addNewMediaItem(newMedia) {
    return new Promise(async (resolve, reject) => {
      await this.db
        .collection('connections')
        .findOneAndUpdate(
          { chatId: this.chatId, 'posts.link': this.currentEditingPostLink },
          { $push: { 'posts.$.media': newMedia } },
        );
      resolve(true);
    });
  }

  handleDeleteMediaItem(uuid) {
    return new Promise(async (resolve, reject) => {
      await this.db
        .collection('connections')
        .findOneAndUpdate(
          { chatId: this.chatId, 'posts.link': this.currentEditingPostLink },
          { $pull: { 'posts.$.media': { uuid: uuid } } },
        );
      resolve(true);
    });
  }

  async handleEditMediaButtonClick() {
    const currentConnection = await this.db
      .collection('connections')
      .findOne({ chatId: this.chatId });
    const currentEditedPost = currentConnection.posts.find(
      (post) => post.link === this.currentEditingPostLink,
    );
    const mediaItems = currentEditedPost.media;
    if (mediaItems.length) {
      let msg = await this.sendSimpleMessage(
        botConstants.messages.yourMediaItems,
        botConstants.markups.editPostMarkup,
      );
      this.afterEditHistory.push(msg);
      await this.sendMediaItemsForDelete(mediaItems);
      this.globalMsg = await this.sendSimpleMessage(
        botConstants.messages.afterMediaItemsSended,
        botConstants.markups.editPostMarkup,
      );
      this.afterEditHistory.push(this.globalMsg);
    } else {
      this.globalMsg = await this.sendSimpleMessage(
        botConstants.messages.emptyMediaItems,
        botConstants.markups.editPostMarkup,
      );
      this.afterEditHistory.push(this.globalMsg);
    }
  }

  sendSimpleMessage(message, reply_markup) {
    return new Promise(async (resolve) => {
      const msg = await this.tgBot.sendMessage(this.chatId, message, {
        parse_mode: 'HTML',
        reply_markup,
      });
      resolve(msg);
    });
  }

  sendMediaItemsForDelete(mediaItems) {
    return new Promise(async (resolve) => {
      const mediaGroup = [];
      mediaItems.forEach((media) => {
        const type = botConstants.mediaTypes[media['type']];
        const url = media.url;

        const mediaObj = {
          uuid: media.uuid,
          type,
          media: url,
        };

        mediaGroup.push(mediaObj);
      });

      for (const mediaGroupItem of mediaGroup) {
        switch (mediaGroupItem.type) {
          case 'photo':
            this.globalMsg = await this.tgBot.sendPhoto(this.chatId, mediaGroupItem.media, {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: 'Удалить ❌',
                      callback_data: `delete_media_item::${mediaGroupItem.uuid}`,
                    },
                  ],
                ],
              },
            });
            this.sendedMediaItemsForDelete.push(this.globalMsg);
            this.afterEditHistory.push(this.globalMsg);
            break;

          case 'video':
            this.globalMsg = await this.tgBot.sendVideo(this.chatId, mediaGroupItem.media, {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: 'Удалить ❌',
                      callback_data: `delete_media_item::${mediaGroupItem.uuid}`,
                    },
                  ],
                ],
              },
            });
            this.sendedMediaItemsForDelete.push(this.globalMsg);
            this.afterEditHistory.push(this.globalMsg);
            break;

          default:
            break;
        }
      }

      resolve();
    });
  }

  getCurrentEditedPost() {
    return new Promise(async (resolve) => {
      const currentConnection = await this.db
        .collection('connections')
        .findOne({ chatId: this.chatId });
      const post = currentConnection.posts.find(
        (post) => post.link === this.currentEditingPostLink,
      );
      resolve(post);
    });
  }

  sendAddSubscribeMessage() {
    return new Promise(async (resolve, reject) => {
      const myChanels = await this.getMyChannels();
      const msg = await this.sendMessageWithChoseSubscribe(myChanels);
      resolve(msg);
    });
  }

  async handlePublishNow() {
    if (!this.currentPublishChannel) {
      const myChanels = await this.getMyChannels();
      let msg = await this.sendMessageWithChoseChannel(myChanels);
      this.afterEditHistory.push(msg);
    } else {
      const result = await this.publishPostInMyChannel();
      if (result.ok) {
        let msg = await this.commandsHandler.sendSuccessfullyPublishPost();
        this.afterEditHistory.push(msg);
        setTimeout(() => {
          this.goToStartScreen();
        }, 2000);
      } else {
        let msg = await this.commandsHandler.sendErrorPublishPost(result.error);
        this.afterEditHistory.push(msg);
      }
    }
  }

  publishPostInMyChannel() {
    return new Promise(async (resolve, reject) => {
      const currentConnection = await this.db
        .collection('connections')
        .findOne({ chatId: this.chatId });
      const posts = currentConnection.posts;
      const post = posts.find((post) => post.link == this.currentEditingPostLink);

      try {
        if (post.media.length) {
          const mediaGroup = [];
          post.media.forEach((media) => {
            const type = botConstants.mediaTypes[media['type']];
            const url = media.url;

            const mediaObj = {
              type,
              media: url,
            };

            mediaGroup.push(mediaObj);
          });

          await this.tgBot.sendMediaGroup(`@${this.currentPublishChannel}`, mediaGroup);
          let description = post.description;
          description = description.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '');
          description = description.replaceAll('<br/>', '');
          description = description.replaceAll('<br />', '');
          description = description.replaceAll('</br>', '');
          description = description.replace(/<img[^>]*>/g, '');
          description = description.replace(/<a\s*[^>]*><\/a>/g, '');
          description = description.trim();

          if (!description) {
            description = 'Выберите действие:';
          }

          await this.tgBot.sendMessage(`@${this.currentPublishChannel}`, description, {
            parse_mode: 'HTML',
          });
        } else {
          let description = post.description;
          description = description.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '');
          description = description.replaceAll('<br/>', '');
          description = description.replaceAll('<br />', '');
          description = description.replaceAll('</br>', '');
          description = description.replace(/<img[^>]*>/g, '');
          description = description.replace(/<a\s*[^>]*><\/a>/g, '');
          description = description.trim();

          await this.tgBot.sendMessage(`@${this.currentPublishChannel}`, description, {
            parse_mode: 'HTML',
          });
        }

        resolve({ ok: true });
      } catch (error) {
        resolve({ ok: false, error });
      }
    });
  }

  handleEditText(newDesription) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.db
          .collection('connections')
          .findOneAndUpdate(
            { chatId: this.chatId, 'posts.link': this.currentEditingPostLink },
            { $set: { 'posts.$.description': newDesription } },
          );
        resolve({ ok: true });
      } catch (error) {
        resolve({ ok: false, error: error });
      }
    });
  }

  async goToEditingScreen(data) {
    this.state.page = 'editPostPage';
    this.state.isSenderBlocked = true;
    this.currentEditingPostLink = data;
    this.currentPublishChannel = null;
    let msg = await this.commandsHandler.sendEditPostMsg();
    this.afterEditHistory.push(msg);
    await this.sendPostWithoutButtons(data, 'editPostMarkup');
  }

  async goToStartScreen() {
    this.state.page = 'startPage';
    this.state.isSenderBlocked = false;
    this.currentEditingPostLink = null;
    this.currentPublishChannel = null;
    await this.handleDeleteHistoryFromEditing();
    await this.commandsHandler.sendStartPageMsg();
  }

  handleDeleteHistoryFromEditing() {
    return new Promise(async (resolve, reject) => {
      for (const msg of this.afterEditHistory) {
        try {
          const msgId = msg.message_id;
          if (!msgId) {
            for (const item of msg) {
              const msgId = item.message_id;
              try {
                await this.tgBot.deleteMessage(this.chatId, msgId);
              } catch (error) {
                console.log(error?.response?.body);
                console.log(item);
              }
            }
            continue;
          }
          await this.tgBot.deleteMessage(this.chatId, msgId);
        } catch (error) {
          console.log(error?.response?.body);
          console.log(msg);
        }
      }
      this.afterEditHistory = [];
      resolve();
    });
  }

  async goToPublishScreen() {
    this.state.page = 'publishScreen';
    this.state.isSenderBlocked = true;
    let msg = await this.commandsHandler.sendPublishPostMsg();
    this.afterEditHistory.push(msg);
    await this.sendPostWithoutButtons(this.currentEditingPostLink, 'publishPostMarkup');
    const myChanels = await this.getMyChannels();
    this.globalMsg = await this.sendMessageWithChoseChannel(myChanels);
    this.afterEditHistory.push(this.globalMsg);
  }

  async sendMessageWithChoseChannel(channels) {
    const msg = await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.choseChannelForPublish,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            channels.map((channel) => {
              return {
                text: channel,
                callback_data: `chose_publish_channel::${channel}`,
              };
            }),
          ],
        },
      },
    );
    return msg;
  }

  async sendMessageWithChoseSubscribe(channels) {
    return await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.choseChannelForAddSubscribe,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            channels.map((channel) => {
              return {
                text: channel,
                callback_data: `add_subscribe_channel::${channel}`,
              };
            }),
          ],
        },
      },
    );
  }

  async getMyChannels() {
    const currentConnection = await this.db
      .collection('connections')
      .findOne({ chatId: this.chatId });
    const channels = currentConnection.myChannels || [];
    return channels;
  }

  sendPostWithoutButtons(link, markup) {
    return new Promise(async (resolve, reject) => {
      const currentConnection = await this.db
        .collection('connections')
        .findOne({ chatId: this.chatId });
      const posts = currentConnection.posts;
      const post = posts.find((post) => post.link == link);

      try {
        if (!post.media.length && !post.description.trim()) {
          let msg = this.sendSimpleMessage(
            botConstants.messages.emptyPostError,
            botConstants.markups[markup],
          );
          this.afterEditHistory.push(msg);
          resolve(true);
          return;
        }

        if (post.media.length) {
          const mediaGroup = [];
          post.media.forEach((media) => {
            const type = botConstants.mediaTypes[media['type']];
            const url = media.url;

            const mediaObj = {
              type,
              media: url,
            };

            mediaGroup.push(mediaObj);
          });

          let msg = await this.tgBot.sendMediaGroup(this.chatId, mediaGroup);
          this.afterEditHistory.push(msg);
          let description = post.description;
          description = description.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '');
          description = description.replaceAll('<br/>', '');
          description = description.replaceAll('<br />', '');
          description = description.replaceAll('</br>', '');
          description = description.replace(/<img[^>]*>/g, '');
          description = description.replace(/<a\s*[^>]*><\/a>/g, '');
          description = description.trim();

          if (!description) {
            description = 'Выберите действие:';
          }

          this.globalMsg = await this.tgBot.sendMessage(this.chatId, description, {
            parse_mode: 'HTML',
            reply_markup: botConstants.markups[markup],
          });
          this.afterEditHistory.push(this.globalMsg);
        } else {
          let description = post.description;
          description = description.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, '');
          description = description.replaceAll('<br/>', '');
          description = description.replaceAll('<br />', '');
          description = description.replaceAll('</br>', '');
          description = description.replace(/<img[^>]*>/g, '');
          description = description.replace(/<a\s*[^>]*><\/a>/g, '');
          description = description.trim();

          let msg = await this.tgBot.sendMessage(this.chatId, description, {
            parse_mode: 'HTML',
            reply_markup: botConstants.markups[markup],
          });
          this.afterEditHistory.push(msg);
        }

        resolve(true);
      } catch (error) {
        resolve(true);
      }
    });
  }

  async setPostIsDeleted(link) {
    return new Promise(async (resolve, reject) => {
      await this.db
        .collection('connections')
        .findOneAndUpdate(
          { chatId: this.chatId, 'posts.link': link },
          { $set: { 'posts.$.deleted': true } },
        );
      resolve(true);
    });
  }

  async deleteMediaItemFromChat(msgId) {
    this.sendedPostMessages = this.sendedPostMessages.filter((msg) => msg.message_id !== msgId);
    return await this.tgBot.deleteMessage(this.chatId, msgId);
  }

  async deleteMessageFromChat(msgId) {
    let msgIndex;
    const msg = this.sendedPostMessages.find((msg, index) => {
      if (msg.message_id == msgId) {
        msgIndex = index;
        return true;
      } else {
        return false;
      }
    });

    if (msgIndex) {
      const previousMsg = this.sendedPostMessages[msgIndex - 1];
      if (Array.isArray(previousMsg)) {
        for (const prevMsg of previousMsg) {
          await this.tgBot.deleteMessage(this.chatId, prevMsg.message_id);
        }
        this.sendedPostMessages = this.sendedPostMessages.filter(
          (_, index) => index !== msgIndex - 1,
        );
      } else {
        if (!previousMsg?.reply_markup?.inline_keyboard) {
          await this.tgBot.deleteMessage(this.chatId, previousMsg.message_id);
          this.sendedPostMessages = this.sendedPostMessages.filter(
            (_, index) => index !== msgIndex - 1,
          );
        }
      }
    }

    this.sendedPostMessages = this.sendedPostMessages.filter((msg) => msg.message_id !== msgId);

    return await this.tgBot.deleteMessage(this.chatId, msgId);
  }

  setPostIsSended(post) {
    return new Promise(async (resolve, reject) => {
      await this.db
        .collection('connections')
        .findOneAndUpdate(
          { chatId: this.chatId, 'posts.link': post.link },
          { $set: { 'posts.$.sended': true } },
        );
      resolve(true);
    });
  }

  handleSaveSubcribedChannels(channels) {
    return new Promise(async (resolve) => {
      try {
        await this.db
          .collection('connections')
          .findOneAndUpdate({ chatId: this.chatId }, { $set: { subscribedChannels: channels } });
        resolve({ ok: true });
      } catch (error) {
        resolve({ ok: false, error: error });
      }
    });
  }

  handleSaveMyChannels(channels) {
    return new Promise(async (resolve) => {
      try {
        await this.db
          .collection('connections')
          .findOneAndUpdate({ chatId: this.chatId }, { $set: { myChannels: channels } });
        resolve({ ok: true });
      } catch (error) {
        resolve({ ok: false, error: error });
      }
    });
  }

  delay(s) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve();
      }, 1000 * s);
    });
  }
}

class CommandsHandler {
  constructor(tgBot, dbClient, chatId) {
    this.tgBot = tgBot;
    this.dbClient = dbClient;
    this.chatId = chatId;

    this.build();
  }

  async build() {
    this.db = await this.dbClient.db('tg_repost_bot2');
  }

  async sendStartPageMsg() {
    await this.tgBot.sendMessage(this.chatId, botConstants.messages.choseOption, {
      parse_mode: 'HTML',
      reply_markup: botConstants.markups.startMarkup,
    });
  }

  async sendEditPostMsg() {
    let msg = await this.tgBot.sendMessage(this.chatId, botConstants.messages.currentEditingPost);
    return msg;
  }

  async sendPublishPostMsg() {
    return await this.tgBot.sendMessage(this.chatId, botConstants.messages.currentPublishingPost, {
      parse_mode: 'HTML',
      reply_markup: botConstants.markups.publishPostMarkup,
    });
  }

  async sendPublishChannelChosen() {
    let msg = await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.publishChannelChosen,
      {
        parse_mode: 'HTML',
        reply_markup: botConstants.markups.publishPostMarkup,
      },
    );
    return msg;
  }

  async stopWatcherMessage() {
    await this.tgBot.sendMessage(this.chatId, botConstants.messages.stopWatcher, {
      parse_mode: 'HTML',
      reply_markup: botConstants.markups.startMarkup,
    });
  }

  async startWatcherMessage() {
    await this.tgBot.sendMessage(this.chatId, botConstants.messages.startWatcher, {
      parse_mode: 'HTML',
      reply_markup: botConstants.markups.startMarkup,
    });
  }

  async sendUpdateSubscribedChannels() {
    await this.tgBot.sendMessage(this.chatId, botConstants.messages.updateSubscribedChannels, {
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({ force_reply: true }),
    });
  }

  async sendUpdateMyChannels() {
    await this.tgBot.sendMessage(this.chatId, botConstants.messages.updateMyChannels, {
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({ force_reply: true }),
    });
  }

  async sendEditTextMessage() {
    const msg = await this.tgBot.sendMessage(this.chatId, botConstants.messages.editText, {
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({ force_reply: true }),
    });
    return msg;
  }

  async sendSuccessfullyUpdatedSubscribedChannels() {
    await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.successfullyUpdateSubscribedChannels,
      { parse_mode: 'HTML', reply_markup: botConstants.markups.startMarkup },
    );
  }

  async sendErrorUpdatedSubscribedChannels(error) {
    await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.errorUpdateSubscribedChannels + ' ' + error,
      { parse_mode: 'HTML', reply_markup: botConstants.markups.startMarkup },
    );
  }

  async sendSuccessfullyPublishPost() {
    const msg = await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.successfullyPublishPost,
      {
        parse_mode: 'HTML',
        reply_markup: botConstants.markups.publishPostMarkup,
      },
    );
    return msg;
  }

  async sendErrorPublishPost(error) {
    const msg = await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.errorPublishPost + ' ' + error,
      { parse_mode: 'HTML', reply_markup: botConstants.markups.publishPostMarkup },
    );
    return msg;
  }

  async sendSuccessfullyUpdatedMyChannels() {
    await this.tgBot.sendMessage(this.chatId, botConstants.messages.successfullyUpdateMyChannels, {
      parse_mode: 'HTML',
      reply_markup: botConstants.markups.startMarkup,
    });
  }

  async sendErrorUpdatedMyChannels(error) {
    await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.errorUpdateMyChannels + ' ' + error,
      { parse_mode: 'HTML', reply_markup: botConstants.markups.startMarkup },
    );
  }

  async sendSuccessfullyEditedText() {
    let msg = await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.successfullyEditedText,
      {
        parse_mode: 'HTML',
        reply_markup: botConstants.markups.editPostMarkup,
      },
    );
    return msg;
  }

  async sendErrorEditedText(error) {
    let msg = await this.tgBot.sendMessage(
      this.chatId,
      botConstants.messages.errorEditedText + ' ' + error,
      {
        parse_mode: 'HTML',
        reply_markup: botConstants.markups.editPostMarkup,
      },
    );
    return msg;
  }

  async sendSubscribedChannels() {
    const currentCcnnection = await this.db
      .collection('connections')
      .findOne({ chatId: this.chatId });
    const channels = currentCcnnection.subscribedChannels || [];
    await this.tgBot.sendMessage(
      this.chatId,
      `Список отслеживаемых каналов:\n${channels.join('\n')} `,
      { parse_mode: 'HTML', reply_markup: botConstants.markups.startMarkup },
    );
  }

  async sendMyChannels() {
    const currentCcnnection = await this.db
      .collection('connections')
      .findOne({ chatId: this.chatId });
    const channels = currentCcnnection.myChannels || [];
    await this.tgBot.sendMessage(this.chatId, `Список моих каналов:\n${channels.join('\n')} `, {
      parse_mode: 'HTML',
      reply_markup: botConstants.markups.startMarkup,
    });
  }
}
