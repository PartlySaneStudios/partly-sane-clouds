import { serealizeBase64NBT } from "../../utils/DataUtils"
import { onCooldown } from "../../utils/MathUtils"
import { prisma } from "../backend"
import { getBazaarData } from "./BazaarData"

async function requestSkyblockAuctionsEndpoint(page: number) {
  const url = `https://api.hypixel.net/v2/skyblock/auctions?page=${page}`
  try {
    const response = await (await fetch(url)).text()
    return response
  } catch(exception) {
    console.error(exception)
    return ""
  }
}

export async function saveAuctionData(): Promise<void> {
  return new Promise((resolve, reject) => {
    const promises = [updateAverageLowestBinTable(),updateAuctionsTable()]
    

    Promise.all(promises).then(() => {
      console.log("Finished saving auctions data")
      prisma.$disconnect()
      resolve()
    })
  })
}

async function updateAverageLowestBinTable() {
  prisma.auctionHouseData.findMany({
    distinct: ["itemId"],
    where: {
      bin: true
    },
    include: { itemData: true }
  }).then( (itemIds) => {
    const promises: Promise<any>[] = []
    itemIds.forEach((item) => {
      promises.push(prisma.averageLowestBinData.create({
        data: {
          itemId: item.itemId,
          time: Date.now(),
          lowestBin: item.itemData.lowestBin
        }
      }))

      
    })
    Promise.all(promises).then(()=> {
      console.log("finished updating average lowest bins")
      
    })
  })
}

async function updateAuctionsTable() {
  console.log("Updating auction data")
  const firstPageResponse = await JSON.parse(await requestSkyblockAuctionsEndpoint(0))
  if (firstPageResponse.success != true) {
    return
  }
  const totalPages = Number(firstPageResponse?.totalPages ?? 0)
  const totalAuctions = Number(firstPageResponse?.totalAuctions ?? 1)

  let lastRequestTime = Date.now()
  let auctionCount = 0
  const promises: Promise<any>[] = []
  for (let i = 0; i < totalPages; i++) {
    if (onCooldown(lastRequestTime, 500)) {
      await new Promise(f => setTimeout(f, Math.abs(Date.now() - (lastRequestTime + 500))));
    }

    const response = await requestSkyblockAuctionsEndpoint(i)
    lastRequestTime = Date.now()

    const responseObject = await JSON.parse(response)

    if (responseObject?.success != true) {
      continue
    }

    const auctionsObject: any[] = responseObject?.auctions

    if (auctionsObject == null) {
      continue
    }


    for (let k = 0; k < auctionsObject.length; k++) {
      auctionCount++
      const auction = auctionsObject[k]
      prisma.auctionHouseData.findFirst({ where:{ uuid: auction?.uuid } }).then( (foundAuction) => {
        if (foundAuction != null) {
          promises.push(prisma.auctionHouseData.update( {
            where: {
              uuid: auction.uuid
            },
            data: {
              highestBid: auction.highest_bid_amount
            }
          }))
        } else {

          const nbtTag = serealizeBase64NBT(auction.item_bytes)

          const itemId = nbtTag?.i[0]?.tag?.ExtraAttributes?.id ?? ""
          
          prisma.auctionHouseData.create({
            data: {
              uuid: auction.uuid,
              playerUUID: auction.auctioneer,
              start: auction.start,
              end: auction.end,
              itemName: auction.item_name,
              itemBytes: auction.item_bytes,
              itemId: itemId,
              bin: auction.bin,
              startingBid: auction.starting_bid,
              highestBid: auction.highest_bid_amount
            }
          }).catch((error) => {
            // console.error(itemId)
            // console.error(error)
            return ""
          })
        }
      })
    }
  }

  Promise.all(promises).then(()=> {
    
    console.log("finished saving aucitons table")
  })
}


async function getLowestBin(itemId: string): Promise<number> {
  const binsFound = await prisma.auctionHouseData.findMany({
    where: {
      AND: {
        bin: true,
        itemId: itemId
      }
    }
  })

  if (binsFound.length == 0) {
    return 0
  }

  let lowestBin = Number.MAX_VALUE
  for (let i = 0; i < binsFound.length; i++) {
    const auction = binsFound[i]

    if (auction.startingBid < lowestBin) {
      lowestBin = Number(auction.startingBid)
    }
  }

  return lowestBin
}

async function getAverageLowestBin(itemId: string, timePeriodMs: number): Promise<number> {
  let entries = await prisma.averageLowestBinData.findMany({
    where: {
      AND: {
        itemId: itemId,
        time: {
          gte: (Date.now() - timePeriodMs)
        }
      }
    }
  })

  // Sorts by time so the trapazoidal Riemann sum works
  entries = entries.sort((a, b) => {
    if (a.time < b.time) {
      return -1
    } else if (a.time < b.time) {
      return 1
    }
    return 0
  })


  // Finds the trapazoidal Riemann sum to find an estimate of the integral
  let previousTime = entries[0]?.time ?? 0
  let sum = 0
  for (let i = 1; i < entries.length - 1; i++) {
    const leftSide = entries[i - 1].lowestBin
    const rightSide = entries[i].lowestBin
    const height = entries[i].time - previousTime

    sum += .5 * (leftSide + rightSide) * Number(height)
  }


  // Finds the average derivative (rate of change) of the riemann sum
  let firstTime = entries[0]?.time ?? 0
  let lastTime = entries[entries.length - 1]?.time ?? 0
  let deltaTime = firstTime - lastTime
  let average = -1
  if (deltaTime ==BigInt(0)) {
    average = entries[0]?.lowestBin ?? 0
  } else {
    average = sum / Number(deltaTime)
  }
  
  return average

}

export async function getAuctionData(itemId: string): Promise<{ lowestBin: number; averageLowestBin: number }> {
  return {
    lowestBin: await getLowestBin(itemId),
    averageLowestBin: await getAverageLowestBin(itemId, 24 * 1000 * 60 * 60)
  }
}
