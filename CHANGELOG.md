# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial WeCom AI Bot long-connection channel plugin for DeepSeek Harness.
- Per-conversation persistent agents with a mounted `preset` (default `standard`).
- Persistent `systemPrompt.section` instructions layered on the persona.
- Single-chat and group text handling plus voice transcription.
- Inbound images: download + AES decryption via the official SDK, durable Harness
  attachments, and a text fallback when the model cannot view images
  (`imageMode`: `auto` / `always` / `never`).
- Inbound files and videos: downloads land in the agent's workspace
  (`.wecom-uploads/`) and are referenced by path for the agent's own tools.
- Access policies (`open` / `allowlist` / `disabled`) for single and group scopes.
- Bot commands: `/bot-ping`, `/bot-help`, `/bot-status`, `/bot-cancel`, `/bot-new`.
- Response timeout that cancels the in-flight turn.
- Global concurrency cap (`maxConcurrent`).
- Streaming reply ack + final answer.
- Secret resolution via `ctx.credentials`.
