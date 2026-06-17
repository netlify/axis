# Changelog

## [1.15.0](https://github.com/netlify/axis/compare/v1.14.0...v1.15.0) (2026-06-15)


### Features

* add AXIS skills ([1d32968](https://github.com/netlify/axis/commit/1d329686fde9399d5e437a276aeebdf2d2b3df4a))


### Bug Fixes

* only show active runs ([e934b74](https://github.com/netlify/axis/commit/e934b7403ce242efa4d120700cd037a26754b48f))

## [1.14.0](https://github.com/netlify/axis/compare/v1.13.0...v1.14.0) (2026-06-03)


### Features

* support remote scenarios ([44c44f1](https://github.com/netlify/axis/commit/44c44f1b7633e48c6a91de2dc4783f3def8e3332))


### Bug Fixes

* adjust the evals for env and agents ([2fee690](https://github.com/netlify/axis/commit/2fee690155df59fecca9922d5ed4f9135ae7242a))
* improve the judge system prompt to stay on track ([2583d1d](https://github.com/netlify/axis/commit/2583d1d633b9f3457c29ef3d193aad5b7d4a18e8))
* reduce visual noise on cli output with judge clarifications ([1ab6e5d](https://github.com/netlify/axis/commit/1ab6e5dc3d05fd8918583ae5e9965e415e8ca5e9))

## [1.13.0](https://github.com/netlify/axis/compare/v1.12.0...v1.13.0) (2026-05-21)


### Features

* add fallback support for agent auth using local sessions ([b1b5fec](https://github.com/netlify/axis/commit/b1b5feccbf63b3b7f0632633c699b1757816bf06))


### Bug Fixes

* add favicon ([d3b241c](https://github.com/netlify/axis/commit/d3b241c3b8f4e5276a082723b23369852ca4c453))

## [1.12.0](https://github.com/netlify/axis/compare/v1.11.0...v1.12.0) (2026-05-20)


### Features

* support scoring via different agents ([2c76fec](https://github.com/netlify/axis/commit/2c76fec03edfb14ab43a5e9baea897093c2378ba))

## [1.11.0](https://github.com/netlify/axis/compare/v1.10.0...v1.11.0) (2026-05-16)


### Features

* isolate the home dir from working dir ([5aaf474](https://github.com/netlify/axis/commit/5aaf474eefe9d29b1e5971c619913b98490d80dd))


### Bug Fixes

* agent selection when you have models too ([341faa2](https://github.com/netlify/axis/commit/341faa28d5a39a023e5ec534ce07e4411e77bb33))
* report interaction expansions ([78a8955](https://github.com/netlify/axis/commit/78a8955dc37045f8c0cb29b607a8efb2a3e61dce))

## [1.10.0](https://github.com/netlify/axis/compare/v1.9.0...v1.10.0) (2026-05-15)


### Features

* add --failed support for targeting only tests that fail ([2cdbc7a](https://github.com/netlify/axis/commit/2cdbc7a56b001a91d0e301456ef2975e72d58be5))
* allow canceling in-flight evals and retain data ([9b79de6](https://github.com/netlify/axis/commit/9b79de6f1a54bebc082b1407c06f372170d8530b))

## [1.9.0](https://github.com/netlify/axis/compare/v1.8.1...v1.9.0) (2026-05-15)


### Features

* rubric -&gt; judge ([b15377c](https://github.com/netlify/axis/commit/b15377c67ad38cc680f3e05c7a82a11e477f7ecc))


### Bug Fixes

* make it clear that things are in teardown mode ([a54de01](https://github.com/netlify/axis/commit/a54de01ea36db4ed96fc04090501eef7a5e7b92e))
* show scenario key on report ([6d4a5bf](https://github.com/netlify/axis/commit/6d4a5bffc3d00eab2f5e9d3e029f50d9b61bea26))
* update default concurrency to 15 ([38526fb](https://github.com/netlify/axis/commit/38526fb8c07e8877eca7489972708a7b528144c1))

## [1.8.1](https://github.com/netlify/axis/compare/v1.8.0...v1.8.1) (2026-05-14)


### Bug Fixes

* add execution status to scoring context ([e9898ea](https://github.com/netlify/axis/commit/e9898ea880f765fab0df2d84289747336307704d))
* gemini token counting and acp error reporting ([8f1d7c2](https://github.com/netlify/axis/commit/8f1d7c234e9089b4e6432e857ca8d574fe059c08))

## [1.8.0](https://github.com/netlify/axis/compare/v1.7.4...v1.8.0) (2026-05-13)


### Features

* support before/after all hooks ([a3cab68](https://github.com/netlify/axis/commit/a3cab68fe2594b5b5bba7f5e4c713035c2c982e4))

## [1.7.4](https://github.com/netlify/axis/compare/v1.7.3...v1.7.4) (2026-05-13)


### Bug Fixes

* improve fuzzy detection of configs ([5de722c](https://github.com/netlify/axis/commit/5de722c2818264d6b8cf317581ce81c81dae48a1))

## [1.7.3](https://github.com/netlify/axis/compare/v1.7.2...v1.7.3) (2026-05-13)


### Bug Fixes

* improve the exports for scenarioinput ([f4742d7](https://github.com/netlify/axis/commit/f4742d749831b24282d7d8dcfb16f265a97ff62c))

## [1.7.2](https://github.com/netlify/axis/compare/v1.7.1...v1.7.2) (2026-05-13)

### Bug Fixes

- bug improvements and cleanup ([b07154b](https://github.com/netlify/axis/commit/b07154b79ec7e136fd163ce98c922a5c62db5214))
- formatting/linting ([cdeca07](https://github.com/netlify/axis/commit/cdeca0739cdcf74d6445192cd1adefa796d4de34))

## [1.7.1](https://github.com/netlify/axis/compare/v1.7.0...v1.7.1) (2026-05-12)

### Bug Fixes

- add axis specific env vars during lifecycle modes ([69ea701](https://github.com/netlify/axis/commit/69ea701de0efc930d3517c48ae0b878f0601ff2f))
- improve acp extraction ([3101b04](https://github.com/netlify/axis/commit/3101b045d043a60328a4eae4b9b29027b43d0150))

## [1.7.0](https://github.com/netlify/axis/compare/v1.6.5...v1.7.0) (2026-05-12)

### Features

- add globs support for scnearios,variants, and agents ([c124bfb](https://github.com/netlify/axis/commit/c124bfba8d1f5c337a7572279481f7c32f0aeada))

## [1.6.5](https://github.com/netlify/axis/compare/v1.6.4...v1.6.5) (2026-05-12)

### Bug Fixes

- make the default timout for lifecycle methods to be larger ([fed03a1](https://github.com/netlify/axis/commit/fed03a19260b8d5c8c17fd1cef2208350c7d67bb))

## [1.6.4](https://github.com/netlify/axis/compare/v1.6.3...v1.6.4) (2026-05-12)

### Bug Fixes

- improve acp end detection ([0b559cc](https://github.com/netlify/axis/commit/0b559cc67f6b59f5e71725426bb5452c797f89de))

## [1.6.3](https://github.com/netlify/axis/compare/v1.6.2...v1.6.3) (2026-05-12)

### Bug Fixes

- env vars should merge ([9ef3967](https://github.com/netlify/axis/commit/9ef3967d971f5dce120b3abd342bcb80ab3d6d54))
- show inline speed tiers ([3f3c307](https://github.com/netlify/axis/commit/3f3c307f37919138530ef2dffd6082e1542b646f))

## [1.6.2](https://github.com/netlify/axis/compare/v1.6.1...v1.6.2) (2026-05-12)

### Bug Fixes

- support debug streaming ([bd2b0ef](https://github.com/netlify/axis/commit/bd2b0ef624a6f59e821dd2fc46499ee1efb5fb3f))

## [1.6.1](https://github.com/netlify/axis/compare/v1.6.0...v1.6.1) (2026-05-11)

### Bug Fixes

- type on config ([c6df111](https://github.com/netlify/axis/commit/c6df111c401b31118dc6257088299aa79d608dc8))

## [1.6.0](https://github.com/netlify/axis/compare/v1.5.0...v1.6.0) (2026-05-11)

### Features

- add docs for expanded agent support ([19d0799](https://github.com/netlify/axis/commit/19d07990c3fa4ae5ec1198e500a22a293cb02aab))

### Bug Fixes

- capitalization ([6627825](https://github.com/netlify/axis/commit/6627825c49327c5776015b1a7f0b7037fa67ec14))
- gemini trust mode ([f9b2a3d](https://github.com/netlify/axis/commit/f9b2a3d3ece914b54500056835952489490aa894))
- homepage report ([63fe35e](https://github.com/netlify/axis/commit/63fe35e405b3dda575d57715ea3d415ae795dccc))

## [1.5.0](https://github.com/netlify/axis/compare/v1.4.0...v1.5.0) (2026-05-08)

### Features

- ensure agent|model keys are used ([9d0ef6e](https://github.com/netlify/axis/commit/9d0ef6e3e5c983b5c412b1a5b15bbe514493c4c9))
- fix up the landing page ([b56ccaa](https://github.com/netlify/axis/commit/b56ccaaa6752bc8e7f2f68bf8f063a9fcaa14abd))

## [1.4.0](https://github.com/netlify/axis/compare/v1.3.1...v1.4.0) (2026-05-07)

### Features

- support artifacts ([a150cfa](https://github.com/netlify/axis/commit/a150cfa35248bfdd0c766eb0ed7184e3f8520de1))
- support artifacts ([9721093](https://github.com/netlify/axis/commit/97210933ce8448ee01dd786323e9ad79a1148389))

## [1.3.1](https://github.com/netlify/axis/compare/v1.3.0...v1.3.1) (2026-05-06)

### Bug Fixes

- tests ([04b28d2](https://github.com/netlify/axis/commit/04b28d26b85907b6c545ad3b1676ae8c8c203b52))

## [1.3.0](https://github.com/netlify/axis/compare/v1.2.2...v1.3.0) (2026-05-06)

### Features

- dynamic configs and axis for axis ([eaa8f9d](https://github.com/netlify/axis/commit/eaa8f9d5edd8bbd5b3ce8801f1e12485b501b8e6))
- improve the rendering of timeline ([e80fb67](https://github.com/netlify/axis/commit/e80fb67fc4c7070cef350d08bcc8deae4c8cdd75))

### Bug Fixes

- improving web search details ([6275565](https://github.com/netlify/axis/commit/6275565a2101bb77dfe1b0488589b2c1a2ad1430))

## [1.2.2](https://github.com/netlify/axis/compare/v1.2.1...v1.2.2) (2026-05-05)

### Bug Fixes

- improving variant reporting ui ([65d26e2](https://github.com/netlify/axis/commit/65d26e2a46ccd23a58cb0cfa358067c207b58383))
- report layout ([d2d4f06](https://github.com/netlify/axis/commit/d2d4f060ff8bf29bac6180887ba101b3d5e4878a))

## [1.2.1](https://github.com/netlify/axis/compare/v1.2.0...v1.2.1) (2026-05-05)

### Bug Fixes

- report adjustments ([3108a5a](https://github.com/netlify/axis/commit/3108a5af374854810fc87ce7ac740810c7892f5b))

## [1.2.0](https://github.com/netlify/axis/compare/v1.1.7...v1.2.0) (2026-05-04)

### Features

- init support ([912fe42](https://github.com/netlify/axis/commit/912fe42b25da19e890bdf7af7c29b6eefc775951))
- support time limits and token limits ([ac782da](https://github.com/netlify/axis/commit/ac782da2078830bc3f04227c08d4dc62e39c0f31))

### Bug Fixes

- axis for axis ([a3eab12](https://github.com/netlify/axis/commit/a3eab12e2c5bf9d2be8046155cb05ff06c102929))
- improve table layouts on report ([141e2f8](https://github.com/netlify/axis/commit/141e2f804b82caaad3d8880cc6bc6fa5cb61e780))
- improve variant rendering on cli ([76ab416](https://github.com/netlify/axis/commit/76ab4164a94dda12dd38adecf5039ab6ae31773c))
- render the variants properly ([37cd2a2](https://github.com/netlify/axis/commit/37cd2a20fa29d34a9f521994d919567f6634057c))

## [1.1.7](https://github.com/netlify/axis/compare/v1.1.6...v1.1.7) (2026-05-04)

### Bug Fixes

- dims ([fe815cc](https://github.com/netlify/axis/commit/fe815cc58c08ba1158e13c3bdb7a5b18c1021fda))
- fix urls ([77e97ec](https://github.com/netlify/axis/commit/77e97ec0c0a6423435aa829d8edc40048d681370))

## [1.1.6](https://github.com/netlify/axis/compare/v1.1.5...v1.1.6) (2026-05-01)

### Bug Fixes

- adjust layout of reports ([531a260](https://github.com/netlify/axis/commit/531a2601beee7457cbb6c4452ca7df3f8696f7f5))
- content tweak ([69b5076](https://github.com/netlify/axis/commit/69b5076a3fd46afee9548eb8a19eb89cab88d61b))
- docs improvement ([aaf2c08](https://github.com/netlify/axis/commit/aaf2c0855d1999849b291e7a953321db092f365f))

## [1.1.5](https://github.com/netlify/axis/compare/v1.1.4...v1.1.5) (2026-04-30)

### Bug Fixes

- improved skip support ([f08e89c](https://github.com/netlify/axis/commit/f08e89c379015bccf870e4d06b0a30c7a48a4ec6))

## [1.1.4](https://github.com/netlify/axis/compare/v1.1.3...v1.1.4) (2026-04-30)

### Bug Fixes

- adjusting the calibration for category judging ([a6b5b04](https://github.com/netlify/axis/commit/a6b5b04fd9e3ccab824c887bb702d213dd126e36))
- skip mode ([8909b41](https://github.com/netlify/axis/commit/8909b41c294794c0cdb2d095181d5b3865999e42))

## [1.1.3](https://github.com/netlify/axis/compare/v1.1.2...v1.1.3) (2026-04-29)

### Bug Fixes

- improve scoring concerns ([b8f2a8d](https://github.com/netlify/axis/commit/b8f2a8d424978daee6b44e901edaf6183515c498))

## [1.1.2](https://github.com/netlify/axis/compare/v1.1.1...v1.1.2) (2026-04-29)

### Bug Fixes

- reuse common workspace ([17f13a4](https://github.com/netlify/axis/commit/17f13a474ca039b9448c00c1a8483c3a415e8727))

## [1.1.1](https://github.com/netlify/axis/compare/v1.1.0...v1.1.1) (2026-04-29)

### Bug Fixes

- release-please is stuck ([cf0e7f5](https://github.com/netlify/axis/commit/cf0e7f5ddbb9d0c7a2a2e68764dbee8b3ec252fa))

## [1.1.0](https://github.com/netlify/axis/compare/v1.0.0...v1.1.0) (2026-04-29)

### Features

- monolithic scoring to multi-category scoring ([d191417](https://github.com/netlify/axis/commit/d191417a25a71bfd90392b849be369e390231d07))

### Bug Fixes

- drop the triage phase for now ([11abff5](https://github.com/netlify/axis/commit/11abff50bac303c31fcac9bcd099254f81019181))

## 1.0.0 (2026-04-29)

### Bug Fixes

- move from diff to compare ([1cc8966](https://github.com/netlify/axis/commit/1cc89665efb1c2600742649f8af4b47398f2734e))
- readme ([501967a](https://github.com/netlify/axis/commit/501967a3ea1fea73d0627accce3d751cca54d166))
- update release please ([b981d8b](https://github.com/netlify/axis/commit/b981d8b6fe5d275ebd69691de552603e89e98c6c))
