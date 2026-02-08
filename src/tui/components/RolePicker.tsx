/**
 * Role Picker Component
 *
 * Simple list picker for selecting an agent role.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { RoleTemplate } from '../../agent-roles.js';

interface RolePickerProps {
  roles: RoleTemplate[];
  onSelect: (role: RoleTemplate) => void;
  onClose: () => void;
  modelName: string;
  maxHeight?: number;
}

export function RolePicker({ roles, onSelect, onClose, modelName, maxHeight = 20 }: RolePickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const titleLines = 2;
  const visibleRows = Math.max(3, maxHeight - titleLines);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(roles.length - 1, prev + 1));
      return;
    }

    if (key.return) {
      onSelect(roles[selectedIndex]);
      return;
    }

    // Number keys for quick select (1-6)
    const num = parseInt(input, 10);
    if (num >= 1 && num <= roles.length) {
      onSelect(roles[num - 1]);
    }
  });

  const visibleRoles = roles.slice(0, visibleRows);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Select role for {modelName} (1-{roles.length}, Enter, Esc cancel)</Text>
      <Box height={1} />

      {visibleRoles.map((role, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={role.id}>
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? '> ' : '  '}
            </Text>
            <Text dimColor>{i + 1}. </Text>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {role.label}
            </Text>
            <Text dimColor>  {role.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
