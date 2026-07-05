import { Box, Text } from 'ink';

export interface ConfirmPromptProps {
  message: string;
}

/** Bordered attention box for a yes/no confirmation, e.g. draining a queue. */
export function ConfirmPrompt({ message }: ConfirmPromptProps) {
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">{message}</Text>
    </Box>
  );
}
