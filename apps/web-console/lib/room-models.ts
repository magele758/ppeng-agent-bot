export type RoomModelLabel = {providerId:string;modelId:string;providerName:string};
export type RoomModelConfiguration = {
 defaultModel: RoomModelLabel|null;
 members: Array<{botId:string;model:RoomModelLabel|null;source:'bot'|'global'|'unconfigured'}>;
};
