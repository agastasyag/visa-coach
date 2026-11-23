// Visa types the officer knows how to run. `focus` tells the officer what a
// real interview for this category tends to probe; `law` is the usual
// refusal basis so the decision sounds real.
export const VISAS = [
  { id: "us-f1", country: "United States", name: "F-1 student", law: "INA 214(b)",
    focus: "why this school and program, how it fits past study and future career, who pays and how much, ties and plans after graduation, English ability, test scores" },
  { id: "us-j1", country: "United States", name: "J-1 exchange visitor", law: "INA 214(b)",
    focus: "program sponsor and DS-2019, what the exchange involves, funding, the two-year home residency rule if it applies, plans after the program" },
  { id: "us-b1b2", country: "United States", name: "B-1/B-2 visitor", law: "INA 214(b)",
    focus: "exact trip purpose, length, who you visit, who pays, job and income at home, travel history, why you will return" },
  { id: "us-h1b", country: "United States", name: "H-1B specialty occupation", law: "INA 221(g) / 214(b)",
    focus: "employer, client site vs employer site, exact job duties, how the degree matches the role, salary, project details, employer size" },
  { id: "us-l1", country: "United States", name: "L-1 intracompany transfer", law: "INA 221(g)",
    focus: "one year of qualifying employment abroad, managerial or specialized knowledge, relationship between the companies, the US role" },
  { id: "us-o1", country: "United States", name: "O-1 extraordinary ability", law: "INA 221(g)",
    focus: "evidence of extraordinary ability, awards, press, judging, the US engagements and petitioner" },
  { id: "us-k1", country: "United States", name: "K-1 fiancé(e)", law: "INA 221(g)",
    focus: "how the couple met, how many times in person, relationship timeline, wedding plans, knowledge of each other's lives and families" },
  { id: "us-cr1", country: "United States", name: "CR-1/IR-1 spouse", law: "INA 221(g)",
    focus: "relationship history, wedding details, living arrangements, shared finances, knowledge of the spouse's life" },
  { id: "uk-student", country: "United Kingdom", name: "Student visa (credibility interview)", law: "Immigration Rules, genuine student requirement",
    focus: "CAS details, why the UK, why this university and course, course content and modules, funds and the 28-day rule, career plan, why not study at home" },
  { id: "uk-visitor", country: "United Kingdom", name: "Standard visitor", law: "Immigration Rules, Appendix V",
    focus: "purpose of visit, itinerary, funds, accommodation, employment at home, intention to leave" },
  { id: "uk-skilled", country: "United Kingdom", name: "Skilled Worker", law: "Immigration Rules, genuineness requirement",
    focus: "sponsor, certificate of sponsorship, job duties, qualifications for the role, salary" },
  { id: "ca-study", country: "Canada", name: "Study permit", law: "IRPR 216(1)",
    focus: "program choice and fit with past study, why Canada, funds and GIC, family ties, plans after study" },
  { id: "ca-visitor", country: "Canada", name: "Visitor visa", law: "IRPR 179(b)",
    focus: "purpose of trip, host, funds, employment and family at home, travel history" },
  { id: "de-student", country: "Germany", name: "Student visa", law: "§ 16b AufenthG",
    focus: "admission, why Germany and this course, blocked account, German or English language level, course plan, career path" },
  { id: "de-jobseeker", country: "Germany", name: "Job seeker / Opportunity Card", law: "§ 20a AufenthG",
    focus: "qualifications and recognition, points, job search plan, funds, language" },
  { id: "au-student", country: "Australia", name: "Student visa (subclass 500)", law: "Genuine Student requirement",
    focus: "course relevance to past study and career, why Australia and this provider, finances, circumstances at home, plans after" },
  { id: "schengen-tourist", country: "Schengen area", name: "Short-stay tourist visa", law: "Schengen Visa Code, Art. 32",
    focus: "itinerary, main destination, hotel bookings, travel insurance, funds, employment, return proof" },
  { id: "schengen-business", country: "Schengen area", name: "Short-stay business visa", law: "Schengen Visa Code, Art. 32",
    focus: "inviting company, meeting agenda, employer letter, who pays, return" },
  { id: "other", country: "Other", name: "Another country or visa", law: "the relevant immigration rules",
    focus: "purpose, funding, ties, eligibility for the category, consistency with the documents" },
];

export const PERSONAS = {
  neutral: "Professional and brisk. Neither warm nor hostile. Typical of a busy consulate window.",
  rushed: "Very rushed: a long queue behind the applicant. Cuts answers short, expects one-sentence replies, may decide after 4-6 questions.",
  sceptical: "Openly sceptical. Assumes the case is weak until the applicant shows otherwise. Presses on any vagueness or inconsistency.",
  friendly: "Friendly tone, but still probing. Puts the applicant at ease, then asks pointed follow-ups.",
};

export const AREAS = [
  { key: "consistency", label: "Answer consistency" },
  { key: "finances", label: "Financial clarity" },
  { key: "intent", label: "Return intent" },
  { key: "ties", label: "Home ties" },
  { key: "purpose", label: "Study / trip purpose" },
  { key: "composure", label: "Composure & delivery" },
];

export function visaById(id) {
  return VISAS.find((v) => v.id === id) || VISAS[VISAS.length - 1];
}
