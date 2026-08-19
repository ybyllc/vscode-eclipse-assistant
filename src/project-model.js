const fs = require('node:fs/promises');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true
});

function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

async function isEclipseProject(directory) {
  try {
    await Promise.all([
      fs.access(path.join(directory, '.project')),
      fs.access(path.join(directory, '.cproject'))
    ]);
    return true;
  } catch {
    return false;
  }
}

async function findProjectRoot(startPath, boundaryPath) {
  let current = path.resolve(startPath);
  const boundary = boundaryPath ? path.resolve(boundaryPath) : path.parse(current).root;
  const stats = await fs.stat(current).catch(() => undefined);
  if (stats?.isFile()) {
    current = path.dirname(current);
  }

  while (true) {
    if (await isEclipseProject(current)) {
      return current;
    }
    if (current === boundary || current === path.dirname(current)) {
      return undefined;
    }
    current = path.dirname(current);
  }
}

async function readProjectInfo(projectDirectory) {
  const [projectXml, cprojectXml] = await Promise.all([
    fs.readFile(path.join(projectDirectory, '.project'), 'utf8'),
    fs.readFile(path.join(projectDirectory, '.cproject'), 'utf8')
  ]);

  const projectDocument = parser.parse(projectXml);
  const cprojectDocument = parser.parse(cprojectXml);
  const projectName = projectDocument?.projectDescription?.name;
  if (typeof projectName !== 'string' || projectName.length === 0) {
    throw new Error(`Unable to read the project name from ${path.join(projectDirectory, '.project')}`);
  }

  const rootModules = asArray(cprojectDocument?.cproject?.storageModule);
  const settings = rootModules.find((module) => module.moduleId === 'org.eclipse.cdt.core.settings');
  const configurations = asArray(settings?.cconfiguration)
    .map((configuration) => {
      const modules = asArray(configuration.storageModule);
      const details = modules.find((module) =>
        module.moduleId === 'org.eclipse.cdt.core.settings' && typeof module.name === 'string'
      );
      return details?.name;
    })
    .filter((name, index, names) => name && names.indexOf(name) === index);

  if (configurations.length === 0) {
    throw new Error(`No CDT managed build configurations were found in ${path.join(projectDirectory, '.cproject')}`);
  }

  return {
    projectDirectory: path.resolve(projectDirectory),
    projectName,
    configurations
  };
}

module.exports = {
  findProjectRoot,
  isEclipseProject,
  readProjectInfo
};
