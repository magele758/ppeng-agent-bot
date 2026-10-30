export type {
  RegisteredMachine,
  RegisteredMachineKind,
  RegisteredMachineBackend,
  RegisteredMachineOpResult,
  RegisteredMachineShellInput,
  RegisteredMachineReadInput,
  RegisteredMachineCopyInput,
  DeviceLocalTool,
  DeviceLocalToolState
} from './types.js';
export { createDisconnectedBackend } from './types.js';
export {
  createSshRegisteredMachineBackend,
  type SshRegisteredMachineBackendOptions
} from './ssh-backend.js';
export {
  createDesktopAgentHub,
  getSharedDesktopAgentHub,
  setSharedDesktopAgentHubForTests,
  type DesktopAgentHub,
  type DesktopAgentHandlers,
  type DesktopAgentAttachment,
  type DesktopAgentHubOptions
} from './agent-hub.js';
export {
  createDesktopAgentBackend,
  type DesktopAgentBackendOptions
} from './agent-backend.js';
export {
  createCompositeRegisteredMachineBackend,
  type CompositeRegisteredMachineBackendOptions
} from './composite-backend.js';
export {
  createRegisteredMachinePort,
  assertRegisteredMachineId,
  denyCrossRailFactoryUse,
  type RegisteredMachinePort
} from './port.js';
export {
  createRegisteredMachineTools,
  executeOnRegisteredMachine
} from './tools.js';
