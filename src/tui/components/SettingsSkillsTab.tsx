/**
 * Settings Skills Tab — OpenClaw skills list with toggle and horizontal scroll.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SkillDescriptor } from '../../types.js';

interface SettingsSkillsTabProps {
  skills: SkillDescriptor[];
  skillsLoading?: boolean;
  skillsError?: string | null;
  allSkillsMode?: boolean;
  selectedIndex: number;
  skillsScrollX: number;
  terminalColumns: number;
}

type Seg = { text: string; color?: string; bold?: boolean; dimColor?: boolean };

function padCell(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value.padEnd(width, ' ');
}

function buildDivider(widths: number[]): string {
  return `  ${'-'.repeat(widths.reduce((sum, width) => sum + width, 0) + ((widths.length - 1) * 2))}`;
}

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= width) { lines.push(remaining); break; }
    let breakAt = remaining.lastIndexOf(' ', width);
    if (breakAt <= 0) breakAt = width;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return lines;
}

function sliceSegments(segments: Seg[], offset: number): React.ReactNode[] {
  if (offset <= 0) {
    return segments.map((s, i) => (
      <Text key={i} color={s.color as never} bold={s.bold} dimColor={s.dimColor}>{s.text}</Text>
    ));
  }
  const result: React.ReactNode[] = [];
  let pos = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const end = pos + s.text.length;
    if (end <= offset) { pos = end; continue; }
    const clip = Math.max(0, offset - pos);
    result.push(
      <Text key={i} color={s.color as never} bold={s.bold} dimColor={s.dimColor}>{s.text.slice(clip)}</Text>
    );
    pos = end;
  }
  return result;
}

const SKILL_NAME_COL_WIDTH = 24;
const SKILL_STATUS_COL_WIDTH = 6;

export function SettingsSkillsTab({
  skills,
  skillsLoading,
  skillsError,
  allSkillsMode,
  selectedIndex,
  skillsScrollX,
  terminalColumns,
}: SettingsSkillsTabProps) {
  const eligibleSkills = skills.filter(s => s.eligible);
  const skillDescColWidth = Math.max(20, terminalColumns - 2 - SKILL_NAME_COL_WIDTH - 2 - SKILL_STATUS_COL_WIDTH - 2 - 4);
  const skillHeader = `  ${padCell('Skill', SKILL_NAME_COL_WIDTH)}  ${padCell('Status', SKILL_STATUS_COL_WIDTH)}  Description`;
  const skillDivider = buildDivider([SKILL_NAME_COL_WIDTH, SKILL_STATUS_COL_WIDTH, skillDescColWidth]);

  if (skillsLoading) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Loading OpenClaw skills...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>The skills OpenClaw Agent will use when operating for ClawTalk. Toggle to enable/disable per Talk. Note every skill adds context and delay!</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={selectedIndex === 0 ? 'cyan' : undefined}>
            {selectedIndex === 0 ? '\u25B8 ' : '  '}
          </Text>
          <Text color={allSkillsMode ? 'green' : 'yellow'} bold>
            {allSkillsMode ? 'All Skills Mode (active)' : 'Reset to All Skills'}
          </Text>
          <Text dimColor>
            {allSkillsMode
              ? ' \u2014 all eligible skills are loaded'
              : ' \u2014 press Enter to enable all skills'}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Eligible Skills</Text>
        {eligibleSkills.length === 0 ? (
          <Text dimColor>  (no eligible skills found)</Text>
        ) : (
          <>
            <Text dimColor>{skillsScrollX > 0 ? skillHeader.slice(skillsScrollX) : skillHeader}</Text>
            <Text dimColor>{skillsScrollX > 0 ? skillDivider.slice(skillsScrollX) : skillDivider}</Text>
            {eligibleSkills.flatMap((skill, idx) => {
              const rowIndex = idx + 1;
              const selected = rowIndex === selectedIndex;
              const enabled = allSkillsMode || skill.enabled;
              const nameCell = padCell(skill.name, SKILL_NAME_COL_WIDTH);
              const statusLabel = enabled ? 'ON' : 'OFF';
              const statusCell = padCell(statusLabel, SKILL_STATUS_COL_WIDTH);
              const descLines = wrapText(skill.description, skillDescColWidth);
              const continuationPad = '  ' + ' '.repeat(SKILL_NAME_COL_WIDTH) + '  ' + ' '.repeat(SKILL_STATUS_COL_WIDTH) + '  ';
              const segments: Seg[] = [
                { text: selected ? '\u25B8 ' : '  ', color: selected ? 'cyan' : undefined },
                { text: nameCell, color: enabled ? 'green' : undefined, bold: enabled },
                { text: '  ' },
                { text: statusCell, color: enabled ? 'green' : 'yellow' },
                { text: '  ' },
                { text: descLines[0] ?? '', dimColor: true },
              ];
              const lines: React.ReactElement[] = [
                <Text key={skill.name}>{sliceSegments(segments, skillsScrollX)}</Text>,
              ];
              for (let i = 1; i < descLines.length; i++) {
                const fullLine = continuationPad + descLines[i];
                lines.push(
                  <Text key={`${skill.name}-${i}`} dimColor>
                    {skillsScrollX > 0 ? fullLine.slice(skillsScrollX) : fullLine}
                  </Text>
                );
              }
              return lines;
            })}
          </>
        )}
      </Box>
      {skillsError && (
        <Box marginTop={1}>
          <Text color="yellow">{skillsError}</Text>
        </Box>
      )}
    </Box>
  );
}
