import { HIDDEN_DIRECTORIES } from '@codesandbox/common/lib/templates/constants/files';
import { Module, Directory } from '@codesandbox/common/lib/types';
import { useOvermind } from 'app/overmind';
import { sortBy } from 'lodash-es';
import * as React from 'react';
import DirectoryEntry from '..';
import ModuleEntry from './ModuleEntry';

interface IDirectoryChildrenProps {
  depth: number;
  renameModule: (title: string, moduleShortid: string) => void;
  setCurrentModule: (id: string) => void;
  parentShortid: string;
  deleteEntry: (shortid: string, title: string) => void;
  isInProjectView: boolean;
  markTabsNotDirty: () => void;
  discardModuleChanges: (shortid: string) => void;
  getModulePath: (
    modules: Module[],
    directories: Directory[],
    id: string
  ) => string;
  renameValidator: (id: string, title: string) => string | false | null;
}

const DirectoryChildren: React.FC<IDirectoryChildrenProps> = ({
  depth = 0,
  renameModule,
  setCurrentModule,
  parentShortid,
  deleteEntry,
  isInProjectView,
  markTabsNotDirty,
  discardModuleChanges,
  getModulePath,
  renameValidator,
}) => {
  const {
    state: { isLoggedIn, editor: editorState },
    actions: { files, editor },
  } = useOvermind();
  const { currentSandbox, mainModule, currentModuleShortid } = editorState;

  const {
    id: sandboxId,
    modules,
    directories,
    template: sandboxTemplate,
  } = currentSandbox;

  return (
    <div>
      {sortBy(directories, 'title')
        .filter(x => x.directoryShortid === parentShortid)
        .filter(
          x =>
            !(
              x.directoryShortid == null && HIDDEN_DIRECTORIES.includes(x.title)
            )
        )
        .map(dir => (
          <DirectoryEntry
            key={dir.id}
            siblings={[...directories, ...modules]}
            depth={depth + 1}
            signals={{ files, editor }}
            store={{ editor: editorState, isLoggedIn }}
            id={dir.id}
            shortid={dir.shortid}
            title={dir.title}
            sandboxId={sandboxId}
            sandboxTemplate={sandboxTemplate}
            mainModuleId={mainModule.id}
            modules={modules}
            directories={directories}
            currentModuleShortid={currentModuleShortid}
            isInProjectView={isInProjectView}
            markTabsNotDirty={markTabsNotDirty}
            getModulePath={getModulePath}
          />
        ))}
      {sortBy(
        modules.filter(x => x.directoryShortid === parentShortid),
        'title'
      ).map(m => (
        <ModuleEntry
          key={m.id}
          module={m}
          depth={depth}
          setCurrentModule={setCurrentModule}
          markTabsNotDirty={markTabsNotDirty}
          renameModule={renameModule}
          deleteEntry={deleteEntry}
          discardModuleChanges={discardModuleChanges}
          getModulePath={getModulePath}
          renameValidator={renameValidator}
        />
      ))}
    </div>
  );
};

export default DirectoryChildren;
