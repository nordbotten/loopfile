# Changelog

## [0.3.0](https://github.com/nordbotten/loopfile/compare/v0.2.0...v0.3.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* rename repositoryPath to targetFolder ([#187](https://github.com/nordbotten/loopfile/issues/187))

### Features

* add empty workspaces for clean runs ([#211](https://github.com/nordbotten/loopfile/issues/211)) ([47c16b2](https://github.com/nordbotten/loopfile/commit/47c16b25b001fd374c40e58b20ab9c1f9003b224))
* **check:** validate remote Loopfiles without trust ([#209](https://github.com/nordbotten/loopfile/issues/209)) ([8f5799a](https://github.com/nordbotten/loopfile/commit/8f5799afd4fd32b3f7f3141ae3b7a0c36f6b191a))
* **cli:** print status summaries when attached loops end ([#179](https://github.com/nordbotten/loopfile/issues/179)) ([cb468fe](https://github.com/nordbotten/loopfile/commit/cb468fef0d9f5cc274ec56eebb6acf492c036ae1))
* **cli:** prompt for loop cancellation mode ([#176](https://github.com/nordbotten/loopfile/issues/176)) ([1b7151f](https://github.com/nordbotten/loopfile/commit/1b7151f163fe2040246e693230ac9a1280043f3d))
* collect loop runs with result ([#180](https://github.com/nordbotten/loopfile/issues/180)) ([6f9c465](https://github.com/nordbotten/loopfile/commit/6f9c4658392b6a27b456daf272f65c35570cfd5c))
* copy workspaces when Git cannot create a worktree ([#203](https://github.com/nordbotten/loopfile/issues/203)) ([7b6bed6](https://github.com/nordbotten/loopfile/commit/7b6bed632cff71e5873090413dc44126f6a725ab))
* GitHub sources support paths and refs ([#177](https://github.com/nordbotten/loopfile/issues/177)) ([e88ed2a](https://github.com/nordbotten/loopfile/commit/e88ed2aedab3bf426f5b673761755775c18f1449))
* launch bare GitHub sources when no local path exists ([#183](https://github.com/nordbotten/loopfile/issues/183)) ([14a1246](https://github.com/nordbotten/loopfile/commit/14a1246bfd65228ee4b71c9605838dc4b8f396ca))
* launch GitHub browser links ([#184](https://github.com/nordbotten/loopfile/issues/184)) ([1d2a703](https://github.com/nordbotten/loopfile/commit/1d2a703733d24651be5b374d91afdff0dc2de0dc))
* loop remote Loopfiles at a pinned commit ([#235](https://github.com/nordbotten/loopfile/issues/235)) ([d79c9da](https://github.com/nordbotten/loopfile/commit/d79c9da492cf47fec041d01b78583dbf3f7fb583))
* loopfile continue &lt;runid&gt; starts the stopped step of an ended run again ([#178](https://github.com/nordbotten/loopfile/issues/178)) ([c665039](https://github.com/nordbotten/loopfile/commit/c66503986df0931c9e32352d03ba5e8f2fe83a37))
* **loop:** resume loops after internal errors ([#214](https://github.com/nordbotten/loopfile/issues/214)) ([4d0ba5f](https://github.com/nordbotten/loopfile/commit/4d0ba5f169ec33340e8686ea571e6a0aa22df631))
* prompt to trust remote Loopfiles ([#201](https://github.com/nordbotten/loopfile/issues/201)) ([cced46d](https://github.com/nordbotten/loopfile/commit/cced46de4ffef15f1725cdf369221dd88866ebfd))
* record remote source metadata on runs ([#205](https://github.com/nordbotten/loopfile/issues/205)) ([56fec21](https://github.com/nordbotten/loopfile/commit/56fec21785183c2e2f652b799e729ff12735c0b5))
* **remote:** trust repositories listed in trust.yaml ([#192](https://github.com/nordbotten/loopfile/issues/192)) ([4d2e0f9](https://github.com/nordbotten/loopfile/commit/4d2e0f99d2b3fa6c1ea0b7689011e0d28b2fb7bf))
* rename repositoryPath to targetFolder ([#187](https://github.com/nordbotten/loopfile/issues/187)) ([684023d](https://github.com/nordbotten/loopfile/commit/684023dacd604f98f28c0bfa2ea898701a6ead18))
* resume crashed loops ([#204](https://github.com/nordbotten/loopfile/issues/204)) ([594928c](https://github.com/nordbotten/loopfile/commit/594928c956205f084faf4ca3b0f6bf904d572ad3))
* run loops from git+https and git+ssh sources ([#188](https://github.com/nordbotten/loopfile/issues/188)) ([8f595c1](https://github.com/nordbotten/loopfile/commit/8f595c1672a2cbb70eca4601ae00e249df93a330))
* run steps in the launch folder with here mode ([#206](https://github.com/nordbotten/loopfile/issues/206)) ([b9cf002](https://github.com/nordbotten/loopfile/commit/b9cf0022144da5e7c3b15e6eb71e589bc9325afa))
* select the isolate workspace mode end to end ([#200](https://github.com/nordbotten/loopfile/issues/200)) ([40d4f6c](https://github.com/nordbotten/loopfile/commit/40d4f6c1f6cda304888ae8ab1ee88b68e93243e3))
* show remote sources in run output ([#207](https://github.com/nordbotten/loopfile/issues/207)) ([7ec38fd](https://github.com/nordbotten/loopfile/commit/7ec38fdb06cc9652e82ea037eca61994f2e5385a))
* show remote trust prompt details ([#202](https://github.com/nordbotten/loopfile/issues/202)) ([e3d1916](https://github.com/nordbotten/loopfile/commit/e3d1916a49d29388654a320da2895804eb380009))
* **unpack:** unpack remote Loopfiles as local sources ([#212](https://github.com/nordbotten/loopfile/issues/212)) ([628b675](https://github.com/nordbotten/loopfile/commit/628b675ec90e90c55a64968fb188a8c6d7da8119))


### Bug Fixes

* accept step calls as soon as the process starts ([#238](https://github.com/nordbotten/loopfile/issues/238)) ([c50d8cf](https://github.com/nordbotten/loopfile/commit/c50d8cff5b44c5c47815ef5e106861860a03d376))
* **check:** skip missing input validation ([#237](https://github.com/nordbotten/loopfile/issues/237)) ([9e7655a](https://github.com/nordbotten/loopfile/commit/9e7655a8ecfe4e9596292912aff6dff9b433c5ab))
* fetch short SHAs with a full-history fallback ([#182](https://github.com/nordbotten/loopfile/issues/182)) ([499bbdb](https://github.com/nordbotten/loopfile/commit/499bbdba8a78244dd0c5654fd9f52bf05002a8a1))
* **list:** show the most recent attempted step ([#236](https://github.com/nordbotten/loopfile/issues/236)) ([f0a33b9](https://github.com/nordbotten/loopfile/commit/f0a33b927f2a2003e928997190b37d9b9639884a))
* **loop:** resume after the remaining pause ([#210](https://github.com/nordbotten/loopfile/issues/210)) ([36fcae8](https://github.com/nordbotten/loopfile/commit/36fcae8251949b4f8cfed2da7857e6e81d4b81e1))
* **quality:** count CRAP complexity from source ([#190](https://github.com/nordbotten/loopfile/issues/190)) ([d6da581](https://github.com/nordbotten/loopfile/commit/d6da5813de9031d84fcd4dfd849b397942ab2f8e))
* **quality:** exclude process tests from Stryker ([#186](https://github.com/nordbotten/loopfile/issues/186)) ([3cbe7f6](https://github.com/nordbotten/loopfile/commit/3cbe7f60fca83c418c65e53731496b1bef63e3c8))
* read the loopfile version from package.json in the loop test ([#168](https://github.com/nordbotten/loopfile/issues/168)) ([cc36f82](https://github.com/nordbotten/loopfile/commit/cc36f82c258983bcaeab964fbfe6a2cee64155e4))
* **remote:** report Git fetch failures clearly ([#189](https://github.com/nordbotten/loopfile/issues/189)) ([a036f34](https://github.com/nordbotten/loopfile/commit/a036f340ece259f0021583bfc8d5fae9474ff590))
* **remove:** honor workspace modes during removal ([#216](https://github.com/nordbotten/loopfile/issues/216)) ([e7c0042](https://github.com/nordbotten/loopfile/commit/e7c004209a6989640096a96692f54f5b47af2f57))
* resume failed and crashed loop children ([#208](https://github.com/nordbotten/loopfile/issues/208)) ([b9b9bc5](https://github.com/nordbotten/loopfile/commit/b9b9bc540ef80c8ba80f205ff5f2b22bfa7be4f5))
* **resume:** honor recorded workspace modes ([#218](https://github.com/nordbotten/loopfile/issues/218)) ([350e217](https://github.com/nordbotten/loopfile/commit/350e217e572de27ba81e5549ce37059bc1aa7797))
* **upgrade:** refuse Remote Loopfiles ([#215](https://github.com/nordbotten/loopfile/issues/215)) ([c8b9c71](https://github.com/nordbotten/loopfile/commit/c8b9c710bedd8e5cb51733c94ffee3ef92d27ab1))

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
