/**
 * 一条命令出 Android 安装包，并把它放到项目根目录的 release/ 里。
 *
 * 为什么需要这个脚本：Gradle 的产物只认自己的约定路径
 * （android/app/build/outputs/apk/release/app-release.apk），又深又被 .gitignore
 * 忽略（`*.apk`），在编辑器里根本看不见。这里统一收拢到 release/，
 * 文件名带上版本与类型，一眼就能认出来。
 *
 * 用法：
 *   npm run apk            出 release 包（已签名，日常安装用这个）
 *   npm run apk -- debug   出 debug 包（带调试标记，排障用）
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const variant = process.argv.includes('debug') ? 'debug' : 'release'
const isWindows = process.platform === 'win32'
const gradlew = path.join(root, 'android', isWindows ? 'gradlew.bat' : 'gradlew')

/** 版本号取自 package.json，免得包名与实际版本对不上 */
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
const version = String(pkg.version ?? '0.0.0')

/**
 * 打包必须用 JDK 17。
 *
 * AGP 8.2 的构件声明面向 Java 11，用 Java 8 启动 Gradle 会直接报
 * 「compatible with Java 8」的变体解析失败——而系统 JAVA_HOME 常常正指向老 JDK，
 * 所以这里**先按候选顺序挑一个真实存在的 17**，挑不到才退回环境变量。
 */
const JAVA_HOME_CANDIDATES = ['D:\\jdk17\\jdk-17.0.10+7', process.env.JAVA_HOME].filter(Boolean)
const javaHome = JAVA_HOME_CANDIDATES.find((dir) => existsSync(path.join(dir, 'bin', 'java.exe')))
const androidHome = process.env.ANDROID_HOME || 'D:/Android/sdk'

const env = {
  ...process.env,
  ...(javaHome ? { JAVA_HOME: javaHome } : {}),
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || androidHome
}

function run(command, args, cwd = root) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: isWindows })
  if (result.status !== 0) {
    console.error(`\n这一步失败了（退出码 ${result.status}），后面不再继续。`)
    process.exit(result.status ?? 1)
  }
}

// 1. 构建渲染层：手机端与桌面端共用同一份产物
run('npm', ['run', 'build'])

// 2. 把前端资源搬进 Android 工程。
//    用 copy 而不是 sync：sync 每次都会重建 capacitor-cordova-android-plugins，
//    那个目录一旦被 Gradle 占着就容易重建到一半失败（踩过）。
//    只有新增原生插件时才需要 sync，那种时候手工跑一次即可。
run('node', ['node_modules/@capacitor/cli/bin/capacitor', 'copy', 'android'])

// 3. 编译并签名
run(gradlew, [`assemble${variant === 'debug' ? 'Debug' : 'Release'}`, '--console=plain'], path.join(root, 'android'))

// 4. 收拢到 release/
const built = path.join(
  root,
  'android/app/build/outputs/apk',
  variant,
  variant === 'debug' ? 'app-debug.apk' : 'app-release.apk'
)
if (!existsSync(built)) {
  console.error(`\n没找到产物：${built}`)
  process.exit(1)
}
const outDir = path.join(root, 'release')
mkdirSync(outDir, { recursive: true })
const target = path.join(outDir, `VinylBox-${version}-${variant}.apk`)
copyFileSync(built, target)

const megabytes = (statSync(target).size / 1024 / 1024).toFixed(1)
console.log(`\n完成 → release\\${path.basename(target)}  ${megabytes}MB`)
