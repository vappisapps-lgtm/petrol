# Live Real-Use Notes

## Database Safety Rule

- Live must use Hostinger MySQL only.
- Do not depend on SQLite for live data anymore.
- Code pushes must not delete, replace, seed, or overwrite live MySQL data.
- Any future database change must be additive by default:
  - create missing tables with `CREATE TABLE IF NOT EXISTS`
  - add missing columns with guarded/ignored `ALTER TABLE`
  - never drop tables
  - never truncate tables
  - never reset the database
  - never auto-create dummy/demo rows on live
- Before pushing any schema change, confirm whether it changes existing live data.

## Current Requested Workflow Changes

1. Day start opening readings are yesterday/previous closing readings.
   - When entering start readings, the system should treat them as the readings carried forward into the selected business date.
   - The entered date/login context should clearly reflect the intended business date.

2. Shift payment logging during active shift.
   - Salesperson should be able to add multiple payments while the shift is active.
   - Each payment should log:
     - time
     - amount
     - payment type
     - pump
     - assigned salesperson/user
   - Closing shift should automatically total/tally these payments.

3. Closing and tallying.
   - Closing should compare calculated pump sales against logged payments.
   - MS and HSD should remain grouped under the pump, not separate shift rows in the UI.

4. Dashboard and reports should focus on:
   - complete sales data by date/day
   - pump-wise MS/HSD readings, litres, and sales
   - salesman/person-wise date data
   - payment totals by type
   - debts/credit values

5. Screenshots are field/layout references only.
   - Ignore dummy values in screenshots.
   - Use the screenshots to understand required fields and reporting shape.

## Confirmed Next Fix Batch

- Payments must be pump-based only.
  - Show pump and assigned user/salesperson.
  - Remove product selection from payment entry.
  - Credit customer should appear only when payment type is Credit.
  - Payment types: Cash, Phone Pay, Credit, Miscellaneous, Beta.
  - Remove Card.
- Active Shifts and Close Shift should show pump rows once, not MS/HSD as separate operational rows.
- Close Shift should:
  - show opening readings
  - show all logged payments for the pump
  - remove additional collections
  - use logged payments for tallying
- Day Closing should:
  - count open shifts by pump, not internal MS/HSD rows
  - ask confirmation before closing day
  - collect manual closing readings pump-wise for MS and HSD
  - save those values so next Day Start can auto-fill pump opening meters
- Day Start should:
  - remove opening cash
  - disable starting a duplicate day
  - show/edit existing open day instead of starting again
  - auto-pick opening meters from the previous closed day
  - not auto-fill from an unclosed day
  - make auto-filled opening meters read-only, with a separate edit path
- Dashboard should show salesperson-wise sales.
- Reports should:
  - filter by pump and salesperson
  - make pump mandatory in all tables
  - group Pump 1/Pump 2 once with MS/HSD data inside
  - remove total litres
  - add MS and HSD price for that day

## Explicitly Ignored For Now

- Price change difference report is not required now.
- Day closing login changes are not required now.
- Pump 2 visibility issue is working now and should not be changed for that reason.

## Implementation Order

1. Confirm live MySQL is the only active live database.
2. Make any required schema changes safely/additively.
3. Implement active shift payment entry.
4. Update shift closing auto-tally.
5. Update dashboard/report views.
6. Test locally and then push live.
