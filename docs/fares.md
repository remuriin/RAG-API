# Tricycall Fares

## How fares are calculated
Tricycall fares are based on a minimum fare plus a per-kilometer rate, similar to how tricycle fares work in most Philippine cities. The minimum fare covers the first kilometer of the trip and up to 2 passengers. Every kilometer beyond that is charged at the standard per-kilometer rate.

In the current test service area, the fare structure is:
- Minimum fare (covers first 1 km, up to 2 passengers): ₱40
- Each additional kilometer: ₱15
- Each additional passenger beyond 2 (same trip): ₱10 flat, regardless of distance
- Waiting time beyond 3 minutes at pickup: ₱2 per minute

These rates are specific to the test service area used during development and are not the same everywhere. Tricycall sets fares per service area, because tricycle fares in the Philippines are regulated locally by each city or municipality rather than by one national rate, so a trip in one city can cost differently from the same distance in another.

## Fare estimate before booking
The app shows an estimated fare before the passenger confirms a booking. This estimate is based on the shortest available route and current conditions. The final fare may differ slightly from the estimate if the driver takes a different route due to traffic or road closures, or if the trip includes extra waiting time.

## Surge pricing
During periods of high demand or low driver availability (heavy rain, rush hour, major local events), fares may increase temporarily. The app always shows the surge multiplier before the passenger confirms the booking, so the passenger can see the adjusted price upfront rather than being surprised afterward.

## Payment methods
Passengers can pay with cash directly to the driver, or through the in-app wallet using GCash, Maya, or a linked debit card. Drivers cannot refuse a passenger for choosing in-app payment over cash.

## Discounts
Tricycall honors standard legally mandated discounts, consistent with discount rules applied to tricycles and other public transport in the Philippines:
- Students: 20% off the metered fare, with valid school ID
- Senior citizens: 20% off the metered fare, with valid senior citizen ID
- Persons with disabilities (PWD): 20% off the metered fare, with valid PWD ID
- Solo parents: 10% off the metered fare, with valid Solo Parent ID

Discounts are applied automatically when the passenger adds a valid ID to their profile. Discounts apply to the metered base fare and distance charge, not to surge multipliers or waiting-time charges.

## Fare disputes
If a passenger believes they were charged incorrectly, they can open the trip in Trip History and tap "Report a fare issue" within 7 days of the trip. Support reviews the trip's recorded route and timing before issuing a refund or fare adjustment. Cash trips can also be disputed, though refunds for cash trips are issued as in-app wallet credit rather than cash.
