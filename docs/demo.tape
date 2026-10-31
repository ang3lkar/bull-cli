# The README demo GIF. Records against Redis db 6, so it never touches db 0 or the test DBs.
#
#   npm run redis:up && npm run build
#   docker run --rm -v "$PWD":/src:ro node:22-alpine sh -c "mkdir /app && cd /src && \
#     cp -r package.json package-lock.json tsconfig.json scripts src /app/ && cd /app && \
#     npm ci --ignore-scripts && npx tsx scripts/seed.ts redis://host.docker.internal:6379/6 --force"
#   vhs docs/demo.tape
#
# The seed runs in a container so the failed jobs' stack traces show /app/... paths rather than
# the local checkout's path. Re-seed before every render: the recording retries a failed job.
Output docs/demo.gif

Set Shell "zsh"
Set FontSize 15
Set Width 1280
Set Height 1000
Set Padding 20
Set TypingSpeed 70ms

Hide
Type "export REDIS_URL=redis://localhost:6379/6 && alias bull-cli='node dist/cli.js' && clear"
Enter
Sleep 500ms
Show

Type "bull-cli"
Sleep 500ms
Enter
Sleep 3s

# Queue list -> reportQ
Down
Sleep 700ms
Down
Sleep 1s
Enter
Sleep 2s

# Step through the status tabs, then jump to Failed
Right
Sleep 1s
Right
Sleep 1s
Type "4"
Sleep 2s

# Open a failed job
Enter
Sleep 4s

# Retry it: the view follows the job back to waiting
Type "R"
Sleep 3500ms

# Back to the list, then home
Escape
Sleep 1500ms
Type "H"
Sleep 2s

Type "q"
Sleep 500ms
