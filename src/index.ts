import { CoreService } from "./services"

async function startup(): Promise<void> {
  const instance = new CoreService()
  await instance.start();
}

void startup()

process.on('unhandledRejection', (error: Error) => {
  console.log('unhandledRejection', error.message)
})
