# Changelog

## [0.2.0](https://github.com/nordbotten/loopfile/compare/v0.1.0...v0.2.0) (2026-09-23)


### Features

* --pause &lt;duration&gt; waits between runs ([d1869e9](https://github.com/nordbotten/loopfile/commit/d1869e9b3771a8b87755745179d23f227df403bd))
* a loop ends when the loopfile program changes ([7a4a59e](https://github.com/nordbotten/loopfile/commit/7a4a59e4171fb13e32325b1bc46fb1f58867e55f))
* add command input source to loops ([#141](https://github.com/nordbotten/loopfile/issues/141)) ([72becec](https://github.com/nordbotten/loopfile/commit/72becec10b9a49ad0ef775a72a5a57eff42f4c7d))
* add interrupt command ([#90](https://github.com/nordbotten/loopfile/issues/90)) ([e70bded](https://github.com/nordbotten/loopfile/commit/e70bded096da31a56756dc0ad5208869cd9ad021))
* agent steps use only repo settings, with auto mode as the default ([b94d456](https://github.com/nordbotten/loopfile/commit/b94d4560e4ba37322312afe85f5a64bb170e9c21))
* cancel loops now or after the current run ([#166](https://github.com/nordbotten/loopfile/issues/166)) ([809ba62](https://github.com/nordbotten/loopfile/commit/809ba6266f005ee7be70c3989c03553a911174f6))
* cap loop runs ([#146](https://github.com/nordbotten/loopfile/issues/146)) ([bcab3f8](https://github.com/nordbotten/loopfile/commit/bcab3f81811f3718811e3a9996931e4545fcbb87))
* defaults for manifest inputs ([f5e019f](https://github.com/nordbotten/loopfile/commit/f5e019f5220b7239419dfd558db393542d18fef9))
* events record attempt metrics ([a6d3e1b](https://github.com/nordbotten/loopfile/commit/a6d3e1bf72c947ae7719cbf2de7cbfb9adfd73ae))
* hint when an attempt ends after denied tool calls ([ca9d3da](https://github.com/nordbotten/loopfile/commit/ca9d3dadfa2f60093488a4e85099fcd11769e6ef))
* link runs to their loops ([#56](https://github.com/nordbotten/loopfile/issues/56)) ([#94](https://github.com/nordbotten/loopfile/issues/94)) ([faf1b41](https://github.com/nordbotten/loopfile/commit/faf1b4142bf8a1974f50befa41a939ef94e97e10))
* list loops in status picker ([#72](https://github.com/nordbotten/loopfile/issues/72)) ([#151](https://github.com/nordbotten/loopfile/issues/151)) ([3a9b2b4](https://github.com/nordbotten/loopfile/commit/3a9b2b47c822b26d765c7a0d57595c7063229aa6))
* list shows loops and each run's loop ([70b1cf3](https://github.com/nordbotten/loopfile/commit/70b1cf3623e794978a1568b5cb4b333131c81245))
* loop IDs, the loop event log and loop status ([87869f0](https://github.com/nordbotten/loopfile/commit/87869f0d6082b8df224599aeabe5198b3646a047))
* loopfile github:owner/repo --trust runs a Remote Loopfile ([b5717fb](https://github.com/nordbotten/loopfile/commit/b5717fbdd14d6ebeb671aa516e8633ee92d3a1bc))
* loopfile loop --times N -d starts a background loop ([abc88be](https://github.com/nordbotten/loopfile/commit/abc88be6f68db85f2eb6abe969602ff47576ca33))
* loopfile loop stays attached and reports each run ([afbdfd4](https://github.com/nordbotten/loopfile/commit/afbdfd42267dc9bef58cf1e44a3b543c3bcb16f1))
* loopfile remove --force ([3819eeb](https://github.com/nordbotten/loopfile/commit/3819eeb9d786c90d9af8aa844db95e9e3e89bb12))
* one error line per input problem at launch and in check ([2cc393e](https://github.com/nordbotten/loopfile/commit/2cc393e26510aad562460ae12f3b90040ed3b37d))
* retry failed loop runs ([#150](https://github.com/nordbotten/loopfile/issues/150)) ([ef2d95e](https://github.com/nordbotten/loopfile/commit/ef2d95e27ff9c92be474ee7d085cfe3d6f944660))
* run loops from JSON Lines input lists ([#140](https://github.com/nordbotten/loopfile/issues/140)) ([893b480](https://github.com/nordbotten/loopfile/commit/893b480d54899bd140567526ba5ef8c6aff0d516))
* run times loops in process ([#59](https://github.com/nordbotten/loopfile/issues/59)) ([#97](https://github.com/nordbotten/loopfile/issues/97)) ([d0de29c](https://github.com/nordbotten/loopfile/commit/d0de29c86a801e68c6aa48b4482a12081376287a))
* show denied tool calls in the activity log and metrics ([073bd8a](https://github.com/nordbotten/loopfile/commit/073bd8a2869c851ec7433e0fe6724d6a7da00d73))
* start runs from code ([#95](https://github.com/nordbotten/loopfile/issues/95)) ([03b1c13](https://github.com/nordbotten/loopfile/commit/03b1c131873c6a5f98b32d952f50c6b9441cca5c))
* status &lt;loopid&gt; shows a totals line with est. cost ([7307fe1](https://github.com/nordbotten/loopfile/commit/7307fe1bb605041f233a87bcacb3a1def3f598bc))
* status &lt;loopid&gt; shows the loop and its recent runs ([cfb6010](https://github.com/nordbotten/loopfile/commit/cfb6010cc4dec9e144e496641536880d1b789f6b))
* status prints once by default, --monitor attaches ([54dafa0](https://github.com/nordbotten/loopfile/commit/54dafa008e3ad485fd61e54039fdc209cb76e290))
* tail &lt;loopid&gt; follows the whole loop ([9c50408](https://github.com/nordbotten/loopfile/commit/9c50408024b0958bf06c93b873e630ba0f22ed30))


### Bug Fixes

* dist/cli.js stays executable after build ([739a672](https://github.com/nordbotten/loopfile/commit/739a6728857b52d8e964c969a033966c48bd2033))
* step agents learn that result is final ([4687c6f](https://github.com/nordbotten/loopfile/commit/4687c6f1cf259629da9e17020634779716c04e61))
* sum harness metrics across calls ([8cee28c](https://github.com/nordbotten/loopfile/commit/8cee28ce06a6be24f86ce56ab7bccae39f826800))
* the monitor no longer leaves lines behind when a line wraps ([bbe9eb2](https://github.com/nordbotten/loopfile/commit/bbe9eb201d086131d3f3e6959d59fe4566afe504))
