import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulesRoot = join(repositoryRoot, 'docs', 'modules');
const registryPath = join(modulesRoot, 'README.md');
const requiredHeadings = [
  '## Purpose and Scope',
  '## User-Facing Capabilities',
  '## Entry Points',
  '## Architecture and Data Flow',
  '## Data Model and Persistence',
  '## Authentication, Roles, and Security',
  '## Integrations and Background Processing',
  '## Cross-Module Dependencies',
  '## Invariants and Failure Behavior',
  '## Validation',
  '## When This Document Must Be Updated',
];

const failures = [];
const registry = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : '';
const registeredSlugs = [...registry.matchAll(/\]\(\.\/([^/)]+)\/README\.md\)/g)].map((match) => match[1]);
const moduleSlugs = existsSync(modulesRoot)
  ? readdirSync(modulesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '_template')
      .map((entry) => entry.name)
      .sort()
  : [];

if (!registry) failures.push('docs/modules/README.md is missing or empty.');

for (const slug of new Set(registeredSlugs)) {
  const readmePath = join(modulesRoot, slug, 'README.md');
  if (!existsSync(readmePath)) {
    failures.push(`Registry link does not resolve: docs/modules/${slug}/README.md`);
  }
}

const duplicateSlugs = registeredSlugs.filter((slug, index) => registeredSlugs.indexOf(slug) !== index);
for (const slug of new Set(duplicateSlugs)) {
  failures.push(`Registry contains duplicate module slug: ${slug}`);
}

for (const slug of moduleSlugs) {
  const readmePath = join(modulesRoot, slug, 'README.md');
  if (!registeredSlugs.includes(slug)) {
    failures.push(`Module directory is missing from registry: ${slug}`);
  }
  if (!existsSync(readmePath)) {
    failures.push(`Module README is missing: ${relative(repositoryRoot, readmePath)}`);
    continue;
  }

  const content = readFileSync(readmePath, 'utf8');
  for (const heading of requiredHeadings) {
    if (!content.includes(heading)) {
      failures.push(`${relative(repositoryRoot, readmePath)} is missing heading: ${heading}`);
    }
  }
}

const documentationFiles = [
  join(repositoryRoot, 'README.md'),
  join(repositoryRoot, 'AGENTS.md'),
  join(repositoryRoot, 'docs', 'blueprint.md'),
  registryPath,
  join(modulesRoot, '_template', 'README.md'),
  ...moduleSlugs.map((slug) => join(modulesRoot, slug, 'README.md')),
].filter(existsSync);

for (const documentationPath of documentationFiles) {
  const content = readFileSync(documentationPath, 'utf8');
  const links = [...content.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);

  for (const link of links) {
    if (/^(?:https?:|mailto:|#)/.test(link)) continue;
    const target = link.replace(/^<|>$/g, '').split('#', 1)[0];
    const resolvedTarget = resolve(dirname(documentationPath), target);
    if (!existsSync(resolvedTarget)) {
      failures.push(
        `${relative(repositoryRoot, documentationPath)} has a broken local link: ${link}`
      );
    }
  }
}

if (failures.length > 0) {
  console.error('Module documentation validation failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Module documentation validation passed for ${moduleSlugs.length} modules.`);
}
