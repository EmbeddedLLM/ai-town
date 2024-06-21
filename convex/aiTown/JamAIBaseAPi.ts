import FormData from "form-data";
import axios from "axios"
import JamAI from "jamaibase";
import { CreateChatTableRequest } from "jamaibase/dist/resources/gen_tables/chat";
import { AddRowRequest, DeleteTableRequest, DuplicateTableRequest, ListTableRowsRequest, UpdateGenConfigRequest } from "jamaibase/dist/resources/gen_tables/tables";
import { ChatRequest } from "jamaibase/dist/resources/llm/chat";
import { CreateKnowledgeTableRequest, UploadFileRequest } from "jamaibase/dist/resources/gen_tables/knowledge";
import { data } from "../../data/spritesheets/f1";

/**
 * Jamai api implementation. Change your respective parameters here to interact with JamAI Base, such as initializing agents and chat completions.
 * 
 * @author wenjie
 */
;

const LLM_CONFIG = {
  MODEL_NAME: 'ellm/Qwen/Qwen2-7B-Instruct',
  MAX_TOKENS: 1000,
  TOP_P: 0.1,
  TEMPERATURE: 1,
  RAG_PARAMS: {
    k: 5,
    reranking_model: 'ellm/BAAI/bge-reranker-v2-m3'
  },
  EMBEDDING_MODEL: 'ellm/BAAI/bge-m3'
}


function createJamAiClient() {
  return new JamAI({ apiKey: process.env.JAMAI_API_KEY, projectId: process.env.JAMAI_PROJECT_ID, baseURL: "https://api.jamaibase.com/" });

}

/**
 * Used for creating chat agents only! @see createAgentConversationTable for conversation agents.
 * @param agentName name of the chat agent
 * @param characterStory backstory, identity and plans etc compressed in a string to be inserted into the chat template. 
 */
async function createAgentChatTable(agentName: string, characterStory: string | undefined) {
  const jamai = createJamAiClient();
  const data: CreateChatTableRequest = {
    id: `Chat_Ai-Town-${agentName}`,
    cols: [
      { id: 'User', dtype: 'str', gen_config: undefined },
      {
        id: 'AI',
        dtype: 'str',
        vlen: 0,
        gen_config: {
          model: LLM_CONFIG.MODEL_NAME,
          messages: [{ role: 'system', content: characterStory as string }],
          temperature: LLM_CONFIG.TEMPERATURE,
          max_tokens: LLM_CONFIG.MAX_TOKENS,
          top_p: LLM_CONFIG.TOP_P,

        }
      }
    ]
  };
  try {
    const response = await jamai.createChatTable(data);
    return response
  } catch (error: any) {
    console.log("CreateChatTable: ", error.message)
  }
}

/**
 * 
// Configures the chat table to enable RAG and type of reranker
 * @param agentName to be used to find the chat table
 * @param characterStory use the same story from createAgentChatTable. If you plan on changing it midgame you may use a different one. 
 */
async function configureAgentChatTable(agentName: string, characterStory: String) {
  const jamai = createJamAiClient();
  const col_map: Record<any, any> = {
    AI: {
      model: LLM_CONFIG.MODEL_NAME,
      messages: [{ role: 'system', content: characterStory }],
      temperature: LLM_CONFIG.TEMPERATURE,
      max_tokens: LLM_CONFIG.MAX_TOKENS,
      top_p: LLM_CONFIG.TOP_P,
      rag_params: {
        k: LLM_CONFIG.RAG_PARAMS.k,
        table_id: `Knowledge_Ai-Town-${agentName}`,
        reranking_model: LLM_CONFIG.RAG_PARAMS.reranking_model
      }
    }
  }
  const body: UpdateGenConfigRequest = {
    table_id: `Chat_Ai-Town-${agentName}`,
    table_type: "chat",
    column_map: col_map
  }
  try {

    const response = await jamai.updateGenConfig(body)
    console.log("Chat Table configured for RAG succesfully.")
    return response;
  } catch (error: any) {
    console.log('Error during configureChatTable:', error.message);
  }

}


/**
 * Creates a conversation table based on a chat agent template defined during game init. 
 * @param agentChatTable the template table to inherit from
 * @param conversationId the conversation agent name, i.e. Bob and Stella: Bob-Stella, Stella-Bob 
 */
async function createAgentConversationTable(agentChatTable: string | undefined, conversationId: string) {
  const jamai = createJamAiClient();
  const body: DuplicateTableRequest = {
    table_id_src: agentChatTable as string,
    table_id_dst: conversationId,
    table_type: "chat",
    include_data: true,
    deploy: true
  }
  try {
    const response = await jamai.duplicateTable(body)
    console.log(`Conversation table ${response.id} created succesfully under ${response.parent_id}`)
  } catch (error: any) {
    console.log("Error during createAgentConversationTable: ", error.message)
  }
}

/**
 * Main function used for chat completion. supports both streaming and none streaming. For a conversation between Bob and Stella,
 * For a conversation agent Stella-Bob, who's chat agent is Stella, userText will be a dialogue by Bob. For a conversation agent Bob-Stella,
 * userText will be a dialogue by Stella. 
 * 
 * @param conversationId the conversation agent to request for a chat completion
 * @param userText the reply from the opposite partner.
 * @param aiText Optional. Pass a string if you want to predefine an AI output, mostly used for creating a template.
 * @returns 
 */
async function generateTextDuringInteraction(conversationId: string | undefined, userText: string, aiText?: string | undefined, isStream: boolean = true): Promise<any> {

  const body: any = {
    table_id: conversationId as string,
    data: [{ User: userText}],
    // table_type: "chat",
    // reindex: false,
    // concurrent: true,
    stream:isStream
  };

  // Include aiText if it is not undefined or null
  if (aiText !== undefined && aiText !== null) {
    body.data[0].AI = aiText;
  }

  try {
  
      const response = await fetch("https://cloud.jamaibase.com/api/v1/gen_tables/chat/rows/add", {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.JAMAI_API_KEY}`,
          'X-PROJECT-ID': `${process.env.JAMAI_PROJECT_ID}`
        },
        body: JSON.stringify(body)
      });
      if(isStream) console.log(`Starting stream for ${conversationId}`)
      else console.log(`Non streaming successful for ${conversationId}`)
      return response;
    
  } catch (error: any) {
    console.error(`Error occured during generateText with ${conversationId}:`, error)
  }
}

/**
 * Creates a chat agent's knowledge table for RAG purposes.
 * @param agentId name of the chat agent to create a knowledge table for.  
 */
async function createAgentKnowledgeTable(agentId: string) {
  const jamai = createJamAiClient();
  const body: CreateKnowledgeTableRequest = {
    id: `Knowledge_Ai-Town-${agentId}`,
    cols: [],
    embedding_model: LLM_CONFIG.EMBEDDING_MODEL
  };
  try {
    const response = await jamai.createKnowledgeTable(body)
    console.log(`${agentId} created succesfully.`)
    return response;
  } catch (error: any) {
    console.log(`Error creating ${agentId} knowledge table: `, error.message)
  }
}

/**
 * Reteieves all rows of a table. Primarily used for getting a conversation agent's list of messages.
 * 
 * @param tableId table name to retrieve the rows.
 * @param offset rows to retrieve from a starting index
 * @param limit the max rows to retrieve, that starts counting from offset.
 * @returns a list of rows, messages etc of a given table.
 */
async function getChatTableRows(tableId: string, offset = 0, limit = 100, table_type = "chat") {
  const jamai = createJamAiClient();
  const body: ListTableRowsRequest = {
    offset: offset,
    limit: limit,
    table_id: tableId,
    table_type: table_type as "chat" | "action" | "knowledge" | undefined,
  }

  try {
    const response = await jamai.listRows(body)
    console.log('Chat table rows retrieved successfully:', response);
    return response

  } catch (error: any) {
    console.error('Error during getChatTableRows:', error.message);
  }
}

/**
 * After hitting a certain defined token threshold exceeding the model's context length, this method is called
 * to dump the contents of a conversation agent into the chat agent's knowledge repository. This will act as the agent's memory,
 * and an chat/conversation agent would retain memories of all its conversations.
 * 
 * @param agentKnowledgeTableId the chat agent's name to find its respective knowledgeTables.
 * @param agentMemoryString the conversation agent's rows.
 */
async function dumpMemoryIntoKnowledgeTable(agentId: string, agentMemoryString: string) {
  const jamai = createJamAiClient();

  // Convert the string to a buffer
  // Create a Readable stream from the string

  const blob = new Blob([agentMemoryString], { type: 'text/plain' });
  const file = new File([blob], "agentMemory.txt", { type: 'text/plain' });


  const body: UploadFileRequest = {
    file: file,
    table_id: `Knowledge_Ai-Town-${agentId}`,
    file_name: `Agent_${agentId}_memory.txt`
  }
  try {
    const response = await jamai.uploadFile(body)

    console.log('Memory dumped into knowledge table successfully:', response);
  } catch (error: any) {
    console.error('Failed to dump memory into knowledge table:', error.response ? error.response.data : error.message);
  }
}

/**
 * Deletes a conversation agent or a table. Primarily used for conversationa agents. after a certain token threshold(checked by the proram) is exceeded to utilize RAG.
 * 
 * @param conversationId the conversation agent to delete
 */
async function deleteConversationTable(conversationId: string, tableType = "chat") {
  const jamai = createJamAiClient();
  const body: DeleteTableRequest = {
    table_id: conversationId,
    table_type: tableType as "chat" | "action" | "knowledge"
  }

  try {
    const response = await jamai.deleteTable(body);
    console.log(`Table ${conversationId} of type ${tableType} deleted succesfully.`)
    return response
  } catch (error: any) {
    console.log("Error deleting a table: ", error.message)
  }
}





export {
  createAgentChatTable,
  configureAgentChatTable,
  createAgentConversationTable,
  generateTextDuringInteraction,
  createAgentKnowledgeTable,
  getChatTableRows,
  dumpMemoryIntoKnowledgeTable,
  deleteConversationTable
}