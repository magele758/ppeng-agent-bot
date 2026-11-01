export {
  createAgentInboxPort,
  stripEmailTag,
  type AgentInboxPort,
  type AgentInbox,
  type EmailThread,
  type EmailMessage
} from './port.js';
export {
  ingestProductDomainEmail,
  emailReceivedMatchesBind,
  recipientsFromEmailBody,
  productEmailFieldsFromBody,
  localPartFromAddress
} from './inbound.js';
