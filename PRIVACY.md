# Privacy and local-data boundary

This private macOS evaluation build is designed for one learner per local
installation. It has no product account system, shared cloud database,
telemetry, or cross-device synchronization.

## What stays on the learner's computer

The following data is stored under the local data directory (`.data/` by
default, or `LISTENING_DATA_DIR` when configured):

- original audio and screen recordings;
- imported and locally generated transcripts;
- listening progress, dictation, review items, learner feedback, and study
  position;
- AI question history, generated explanations, and the local provider/model
  preference; and
- the 30-day recoverable trash.

Downloaded speech-recognition models are stored in `.models/`. Both directories
are excluded from Git. Common audio and video extensions are also excluded as a
second safeguard if a file is accidentally copied elsewhere in the repository.

Each tester has a separate local data directory and uses their own locally
authenticated official CLI accounts. Installing or updating the source code
does not upload or synchronize one tester's materials, settings, credentials,
or account usage with another tester.

## When external services are contacted

- **Selected AI provider:** only the transcript context needed for an analysis
  or question is passed to the tester's own locally authenticated Codex or
  Cursor Agent process. Original audio/video is not sent to either AI provider
  by this application. The learner chooses the provider and model on first
  launch, can switch later from the global setting, and the application does
  not silently fall back to the other provider.
- **Feishu/Lark:** when a tester explicitly imports a Minutes link, the local
  Feishu/Lark tooling contacts that service using the tester's own account and
  permissions to retrieve the selected material.
- **Model download:** setup may download a local speech-recognition model. The
  model runs on the tester's computer after download.

The application does not silently fall back to a separately billed AI API.

## GitHub and support

Never commit recordings, transcripts, `.data/`, `.models/`, environment files,
local auth/settings directories, credentials, logs, or generated output. Never
paste private meeting content, credentials, or tokens into a GitHub issue,
pull request, Actions log, or screenshot. Use a minimal fictional reproduction
when reporting a bug.

## Deletion

Deleting a material moves its local files to the application's trash. They can
be restored for 30 days, after which the application may permanently remove
them. Deleting the local data directory removes the remaining learning data for
that installation. Git operations do not back up or restore local learning
data.

## Tester responsibility

Only import material that you are authorized to access and process. Follow the
meeting owner's confidentiality requirements and your organization's policies.
