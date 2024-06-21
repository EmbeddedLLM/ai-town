import { v } from 'convex/values';
import { Id } from '../_generated/dataModel';
import { ActionCtx, internalQuery } from '../_generated/server';
import { LLMMessage, chatCompletion } from '../util/llm';
import * as memory from './memory';
import { api, internal } from '../_generated/api';
import * as embeddingsCache from './embeddingsCache';
import { GameId, conversationId, playerId } from '../aiTown/ids';
import { NUM_MEMORIES_TO_SEARCH } from '../constants';
import * as jamAiApi from "../aiTown/JamAIBaseAPi";
import { PageListTableRowsResponse } from 'jamaibase/dist/resources/gen_tables/tables';

/**
 * All implementations that relate to a conversation should be placed in here
 * 
 * @author wenjie
 */

const selfInternal = internal.agent.conversation;

/**
 * At any time, only one agent may start a conversation. The agent initiaiting the conversation will
 * attempt to grab the conversation lock. The agent starting the conversation will receieve different
 * prompts compared to the agent leaving or continuing one.
 * 
 * This function will initialize a conversation agent based on a chat agent template defined during game init
 * (in convex/aiTown/agentInputs.ts). Subsequent initializations will not matter because the api calls are
 * idempotent. It will simply return resource exists if the table exists already. 
 * 
 * @author wenjie
 * @param ctx 
 * @param worldId 
 * @param conversationId 
 * @param playerId 
 * @param otherPlayerId 
 * @returns 
 */
export async function startConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
) {
  const { player, otherPlayer, agent, otherAgent, lastConversation } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  // Does this twice because only 1 agent starts a conversation at a time, the other agent always continues it
  await jamAiApi.createAgentConversationTable(agent.chatTableId, `${player.name}-${otherPlayer.name}`);
  if(!otherPlayer.human) await jamAiApi.createAgentConversationTable(otherAgent?.chatTableId, `${otherPlayer.name}-${player.name}`);


  // Add to convo list for token tracking, later used for memory dumps
  let conversation = { conversationId: `${player.name}-${otherPlayer.name}`, tokenCount: 0 }
  let otherConversation = { conversationId: `${otherPlayer.name}-${player.name}`, tokenCount: 0 }

  if (!agent.conversationList?.some(conv => conv.conversationId === conversation.conversationId)) {
    agent.conversationList?.push(conversation)
  }
  if (!otherAgent?.conversationList?.some(conv => conv.conversationId === otherConversation.conversationId)) {
    otherAgent?.conversationList?.push(conversation)
  }


  const prompt = [
    `You are ${player.name}, and you just started a conversation with ${otherPlayer.name}. Do NOT describe what you will do. Assume this is a dialogue in a first person point of view. You may refer to previous chat histories to form your response.`,
  ];
  prompt.push(...agentPrompts(otherPlayer, agent, otherAgent ?? null));


  const { content } = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: prompt.join('\n'),
      },
    ],
    max_tokens: 300,
    stream: true,
    stop: stopWords(otherPlayer.name, player.name),
    conversationId: conversation.conversationId
  });
  return content;
}

/**
 * All agents will be using this function to reply. If agent A starts a conversation, agent B continues, and so on.
 * Note that previousMessages() was changed to only return the most recent single message from the convo partner. 
 * The most recent single message is the partner's reply. This is necessary for multiturn conversations.
 * 
 * Example:
 * 
 * Agent A (startConversationMessage): Hello, Agent B.
 * Agent B (continueConversationMessage): previousMessages() returned "Hello, Agent B". So, Agent B replies "Hello Agent A."
 *  @param ctx 
 * @param worldId 
 * @param conversationId 
 * @param playerId 
 * @param otherPlayerId 
 * @returns 
 */
export async function continueConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
) {

  const { player, otherPlayer, conversation, agent, otherAgent } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );

  // For the edge case where a human player starts the conversation, the agent has to create its own conversation agent.
  // this is because for the edge case, in the top level layer where the human player initiates the convo, it does not support async functions. 
  if(otherPlayer.human && conversation?.numMessages == 1){
    await jamAiApi.createAgentConversationTable(agent.chatTableId, `${player.name}-${otherPlayer.name}`);
    let conversation = { conversationId: `${player.name}-${otherPlayer.name}`, tokenCount: 0 }
    if (!agent.conversationList?.some(conv => conv.conversationId === conversation.conversationId)) {
      agent.conversationList?.push(conversation)
    }
  }
  const now = new Date(Date.now());
  const started = new Date(conversation ? conversation.created : 0);
  const prompt = [
    `The conversation first started at ${started.toLocaleString()}. It's now ${now.toLocaleString()}.`,
  ];

  // prompt.push(
  //   `Remember the identity of both you and ${otherPlayer.name} to formulate your response accordingly.`,

  // );


  const llmMessages: LLMMessage[] = [
    {
      role: 'user',
      content: prompt.join('\n'),
    },
    ...(await previousMessages(
      ctx,
      worldId,
      player,
      otherPlayer,
      conversation ? conversation.id as GameId<'conversations'> : -1 as any | GameId<'conversations'>,
    )),
  ];


  const { content } = await chatCompletion({
    messages: llmMessages,
    max_tokens: 300,
    stream: true,
    stop: stopWords(otherPlayer.name, player.name),
    conversationId: `${player.name}-${otherPlayer.name}`
  });
 

  return content;
}


/**
 * Only one agent may initiate to leave the conversation. The chat completion recieves a different prompt.
 * @param ctx 
 * @param worldId 
 * @param conversationId 
 * @param playerId 
 * @param otherPlayerId 
 * @returns 
 */
export async function leaveConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
) {
  const { player, otherPlayer, conversation, agent, otherAgent } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  const prompt = [
    `You are ${player.name}, and you're currently in a conversation with ${otherPlayer.name}.`,
    `You've decided to leave the question and would like to politely tell them you're leaving the conversation.`,
  ];
  prompt.push(...agentPrompts(otherPlayer, agent, otherAgent ?? null));
  prompt.push(
    `Below is the most recent dialogue between you and ${otherPlayer.name}.`,
    `How would you like to tell them that you're leaving? Your response should be brief and within 200 characters.`
  );
  const llmMessages: LLMMessage[] = [
    {
      role: 'user',
      content: prompt.join('\n'),
    },
    ...(await previousMessages(
      ctx,
      worldId,
      player,
      otherPlayer,
      conversation ? conversation.id as GameId<'conversations'> : -1 as any | GameId<'conversations'>,
    )),
  ];

  const { content } = await chatCompletion({
    messages: llmMessages,
    max_tokens: 300,
    stream: true,
    stop: stopWords(otherPlayer.name, player.name),
    conversationId: `${player.name}-${otherPlayer.name}`
  });

  return content;
}


/**
 * This function is called after every chat completion has finished. Necessary to keep track of token usage to 
 * decide when to do a memory dump. 
 * @param ctx 
 * @param worldId 
 * @param conversationId 
 * @param playerId 
 * @param otherPlayerId 
 * @param totalTokens 
 */
export async function updateTokens(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
  totalTokens: number,

) {
  const { player, otherPlayer, agent, otherAgent } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  const convo = agent.conversationList?.find(c => c.conversationId === `${player.name}-${otherPlayer.name}`)
  const otherConvo = otherAgent?.conversationList?.find(c => c.conversationId === `${otherPlayer.name}-${player.name}`)
  if (convo != undefined) convo.tokenCount = totalTokens;
  if (otherConvo != undefined) otherConvo.tokenCount = totalTokens;
}


/**
 * Deletes the conversation agent and dumps all logs into the knowledge table for persistence and RAG. 
 * Gives agents the ability to recall and mention conversations they had with someone else during a 1:1.
 * Also gives the conversation agent the ability to grow and change their personalities that was othewrwise defined by the chat agent template and the system prompt.
 * 
 * Note that this function will be called by both agents in a conversation during agentRememberConversation. All api calls are idempotent, so repeated calls will not
 * change an outcome. During agentRememberConversation, they will not be able to initiate a new conversation,
 * so we dont have to worry about a premature dump.
 * 
 * Removing the line that dumps the other agent's table causes the game to break for some reason. The conversationId ends up getting deleted by the game itself by the time the other agent tries to
 * dump its own knowledge table, which causes agentRememberConversation to throw conversationId not found, killing the engine. So whoever gets to do it first should do it for the other.
 * 
 * @author wenjie
 * @param ctx 
 * @param worldId 
 * @param conversationId 
 * @param playerId 
 * @param otherPlayerId 
 * 
 */
export async function dumpConversationTable(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
) {

  const { player, otherPlayer, agent, otherAgent } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  let data = await jamAiApi.getChatTableRows(`${player.name}-${otherPlayer.name}`);
  // Join the memory rows into a single string with newline characters
  if (data) {
    await dumpMemory(data, player.name, otherPlayer.name, otherAgent?.identity)

  }
  let otherData = await jamAiApi.getChatTableRows(`${otherPlayer.name}-${player.name}`);
  if (otherData) {
    await dumpMemory(otherData, otherPlayer.name, player.name, otherAgent?.identity)
  }
  const convo = agent.conversationList?.find(c => c.conversationId === `${player.name}-${otherPlayer.name}`)
  const otherConvo = otherAgent?.conversationList?.find(c => c.conversationId === `${otherPlayer.name}-${player.name}`)
  // Reset the agent's token count
  if (convo !== undefined) convo.tokenCount = 0;
  await jamAiApi.deleteConversationTable(`${player.name}-${otherPlayer.name}`)
}




/**
 * Before dumping, sanitizes the responsebody containing all chat rows of a conversation agent to become a more RAG friendly
 * format for agents to recall key points. 
 */
async function dumpMemory(responseBody: PageListTableRowsResponse, player: string, otherPlayer: string, otherPlayDesc: string | undefined) {
  const items = responseBody.items;
  const allContents: string[] = [];
  if (otherPlayDesc) {
    allContents.push(otherPlayDesc)
  }

  items.reverse().forEach(item => {
    if (item.User) {
      const userContent = item.User.value;
      const otherPlayerDialogueStart = userContent.indexOf(`${otherPlayer} to ${player}:`);

      if (otherPlayerDialogueStart !== -1) {
        const relevantText = userContent.substring(otherPlayerDialogueStart);
        allContents.push(`Conversation started at: ${item["Updated at"]}`);
        allContents.push(relevantText)
      } else {
        allContents.push(`Summary of conversation with ${otherPlayer} that ended at ${item["Updated at"]}: \n`)
      }
      // Extract content from AI property
      if (item.AI) {
        allContents.push(`${player}: ` + item.AI.value);
      }

    }

  });

  // Join the array into a single string with newline characters
  const fileContent = allContents.join('\n');
  await jamAiApi.dumpMemoryIntoKnowledgeTable(player, fileContent);
}

/**
 * Removed the current agent's prompt because already configured system prompt and agent template to include
 * their identity during game init in convex/aiTown/agentInputs.ts
 */
function agentPrompts(
  otherPlayer: { name: string },
  agent: { identity: string; plan: string } | null,
  otherAgent: { identity: string; plan: string } | null,
): string[] {
  const prompt = [];
  // if (agent) {
  //   prompt.push(`About you: ${agent.identity}`);
  //   prompt.push(`Your goals for the conversation: ${agent.plan}`);
  // }
  if (otherAgent) {
    prompt.push(`About ${otherPlayer.name}: ${otherAgent.identity}`);
  }
  return prompt;
}

/**
 * All functions below is already handled by Jamai. Not needed. 
 * @param otherPlayer 
 * @param conversation 
 * @returns 
 */
function previousConversationPrompt(
  otherPlayer: { name: string },
  conversation: { created: number } | null,
): string[] {
  const prompt = [];
  if (conversation) {
    const prev = new Date(conversation.created);
    const now = new Date();
    prompt.push(
      `Last time you chatted with ${otherPlayer.name
      } it was ${prev.toLocaleString()}. It's now ${now.toLocaleString()}.`,
    );
  }
  return prompt;
}

function relatedMemoriesPrompt(memories: memory.Memory[]): string[] {
  const prompt = [];
  if (memories.length > 0) {
    prompt.push(`Here are some related memories in decreasing relevance order:`);
    for (const memory of memories) {
      prompt.push(' - ' + memory.description);
    }
  }
  return prompt;
}

// async function previousMessages(
//   ctx: ActionCtx,
//   worldId: Id<'worlds'>,
//   player: { id: string; name: string },
//   otherPlayer: { id: string; name: string },
//   conversationId: GameId<'conversations'>,
// ) {
//   const llmMessages: LLMMessage[] = [];
//   const prevMessages = await ctx.runQuery(api.messages.listMessages, { worldId, conversationId });
//   for (const message of prevMessages) {
//     const author = message.author === player.id ? player : otherPlayer;
//     const recipient = message.author === player.id ? otherPlayer : player;
//     llmMessages.push({
//       role: 'user',
//       content: `${author.name} to ${recipient.name}: ${message.text}`,
//     });
//   }
//   return llmMessages;
// }

/**
 * Only returns ONE message. Containing the convo partner's response. Used to engage in multiturn convos.
 * @param ctx 
 * @param worldId 
 * @param player 
 * @param otherPlayer 
 * @param conversationId 
 * @returns 
 */
async function previousMessages(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  player: { id: string; name: string },
  otherPlayer: { id: string; name: string },
  conversationId: GameId<'conversations'>,
) {
  const llmMessages: LLMMessage[] = [];
  const prevMessages = await ctx.runQuery(api.messages.listMessages, { worldId, conversationId });

  if (prevMessages.length > 0) {
    const message = prevMessages[prevMessages.length - 1];
    const author = message.author === player.id ? player : otherPlayer;
    const recipient = message.author === player.id ? otherPlayer : player;
    llmMessages.push({
      role: 'user',
      content: `${author.name} to ${recipient.name}: ${message.text}`,
    });
  }

  return llmMessages;
}

export const queryPromptData = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId,
    otherPlayerId: playerId,
    conversationId,
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    if (!player) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!playerDescription) {
      throw new Error(`Player description for ${args.playerId} not found`);
    }
    const otherPlayer = world.players.find((p) => p.id === args.otherPlayerId);
    if (!otherPlayer) {
      throw new Error(`Player ${args.otherPlayerId} not found`);
    }
    const otherPlayerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.otherPlayerId))
      .first();
    if (!otherPlayerDescription) {
      throw new Error(`Player description for ${args.otherPlayerId} not found`);
    }
    const conversation = world.conversations.find((c) => c.id === args.conversationId);
    if (!conversation && !player) {

      throw new Error(`Conversation ${args.conversationId} not found`);
    }
    const agent = world.agents.find((a) => a.playerId === args.playerId);
    if (!agent) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const agentDescription = await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', agent.id))
      .first();
    if (!agentDescription) {
      throw new Error(`Agent description for ${agent.id} not found`);
    }
    const otherAgent = world.agents.find((a) => a.playerId === args.otherPlayerId);
    let otherAgentDescription;
    if (otherAgent) {
      otherAgentDescription = await ctx.db
        .query('agentDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', otherAgent.id))
        .first();
      if (!otherAgentDescription) {
        throw new Error(`Agent description for ${otherAgent.id} not found`);
      }
    }
    const lastTogether = await ctx.db
      .query('participatedTogether')
      .withIndex('edge', (q) =>
        q
          .eq('worldId', args.worldId)
          .eq('player1', args.playerId)
          .eq('player2', args.otherPlayerId),
      )
      // Order by conversation end time descending.
      .order('desc')
      .first();

    let lastConversation = null;
    if (lastTogether) {
      lastConversation = await ctx.db
        .query('archivedConversations')
        .withIndex('worldId', (q) =>
          q.eq('worldId', args.worldId).eq('id', lastTogether.conversationId),
        )
        .first();
      if (!lastConversation) {
        throw new Error(`Conversation ${lastTogether.conversationId} not found`);
      }
    }
    return {
      player: { name: playerDescription.name, ...player },
      otherPlayer: { name: otherPlayerDescription.name, ...otherPlayer },
      conversation,
      agent: { identity: agentDescription.identity, plan: agentDescription.plan, ...agent },
      otherAgent: otherAgent && {
        identity: otherAgentDescription!.identity,
        plan: otherAgentDescription!.plan,
        ...otherAgent,
      },
      lastConversation,
    };
  },
});

function stopWords(otherPlayer: string, player: string) {
  // These are the words we ask the LLM to stop on. OpenAI only supports 4.
  const variants = [`${otherPlayer} to ${player}`];
  return variants.flatMap((stop) => [stop + ':', stop.toLowerCase() + ':']);
}
