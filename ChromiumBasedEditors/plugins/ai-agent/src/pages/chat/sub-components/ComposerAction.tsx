import { ComposerActionAttachment } from "./ComposerActionAttachments";
import { ComposerActionEffort } from "./ComposerActionEffort";
import { SelectModel } from "./ComposerActionSelectModel";
import { ComposerActionSend } from "./ComposerActionSend";
import { ServersSettings } from "./ComposerActionServers";

const ComposerAction = () => {
  return (
    <div className="relative flex flex-col">
      <div className="relative flex items-center justify-between h-[24px]">
        <div className="flex items-center gap-[12px] flex-row">
          <ComposerActionAttachment />
          <ServersSettings />
        </div>

        <div className="flex items-center gap-[12px] flex-row">
          <ComposerActionEffort />
          <SelectModel />
          <ComposerActionSend />
        </div>
      </div>
    </div>
  );
};

export { ComposerAction };
